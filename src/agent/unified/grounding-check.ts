/**
 * Layer 2 — per-tool grounding check (pre-execute gate).
 *
 * Generalizes `requiredFieldExtractionCheck` (recalibrate-only) to a
 * per-tool gate on every unified-agent write tool.
 *
 * 2026-05-12 redesign (proposal: grounding-check-evidence-scope-redesign,
 * decided 2026-05-12). Two-scope framework + value-match upgrades:
 *
 *   - `evidenceScope: "currentMessage" | "recentThread"` per non-derivable
 *     field. `recentThread` aligns with the 2-turn preload the runner already
 *     loads for prompt context (eaa9c2c). Fixes cmp2wlgke false-block on bare
 *     confirmations like "yes, do that".
 *   - `valueMatch: "token" | "exact"` per field — when set, the check accepts
 *     iff the emitted value appears in EITHER the evidence-scope text OR the
 *     this-turn tool results. Closes F18-class fabrication holes that the
 *     regex shape-check left open (e.g. model emits `inviteeName: "Susan"`
 *     while host said "John" — regex matches "John" but value didn't).
 *   - `derivable: true` (existing flag, retained) — orthogonal to scope. Value
 *     must be present in tool input AND (if `valueMatch: "exact"`) must
 *     appear in this-turn tool results.
 *
 * Stale-history degradation: when the prompt-context staleness trim kicks in
 * (>10min gap, 650b01e), `recentThread` is `undefined` and the check returns
 * a distinctive "context stale" error so the model can ask the host to
 * re-state instead of falling silently to current-message-only.
 *
 * The check is deliberately lightweight — lexical/structural, not semantic.
 * False positives cost a model retry; they do not drop real user intent.
 * Severity "advisory" means a false positive is non-blocking.
 *
 * Strict tools (irreversible): session_cancel, session_archive_bulk,
 * rule_remove, primary_link_update, prefs_update_business_hours,
 * prefs_update_timezone, session_hold_slot, session_set_status,
 * session_confirm_slot, session_request_reschedule.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where evidence may live for a non-derivable field. */
export type EvidenceScope = "currentMessage" | "recentThread";

/** When set, the emitted value itself must appear in scope (not just shape). */
export type ValueMatchStrategy = "token" | "exact";

export type GroundingFieldCheck = {
  /** The field on the tool's inputSchema to check. */
  field: string;
  /**
   * Whether the field can be derived from context (LOAD_ tool output) vs
   * must be evidenced in conversation text.
   * derivable = true  → presence in the tool call args is sufficient evidence,
   *                     plus (if `valueMatch: "exact"`) the value must appear
   *                     in this-turn tool results.
   * derivable = false → must appear in the evidence-scope text (regex match).
   */
  derivable: boolean;
  /**
   * Where evidence may live for this field (when !derivable).
   * Defaults to "currentMessage" for backward compat; new declarations
   * should set explicitly.
   */
  evidenceScope?: EvidenceScope;
  /** Regex patterns that confirm shape-of-evidence (used when !derivable). */
  patterns?: readonly RegExp[];
  /**
   * Optional: also require the emitted value to appear in scope (text +
   * tool results). "token" splits the value on whitespace and accepts if
   * ANY token appears OR the full value appears in tool results. "exact"
   * requires the full value as a substring in scope.
   */
  valueMatch?: ValueMatchStrategy;
  /** If the field is missing or ungrounded, is the check advisory or strict? */
  severity: "advisory" | "strict";
};

export type GroundingDeclaration = {
  toolName: string;
  /** Fields to validate. All must pass for the check to clear. */
  fields: readonly GroundingFieldCheck[];
  /**
   * Overall tool severity — if ANY strict field fails, the error message is
   * escalated regardless of individual field severity.
   */
  toolSeverity: "advisory" | "strict";
};

/** Typed shape of recent thread for grounding evidence. */
export type RecentThread = {
  priorUserTurn?: string;
  priorEnvoyTurn?: string;
};

/**
 * Typed wrapper for tool results consulted by value-match extractors.
 * Keeps the per-tool extractor logic centralized in this file (one source
 * of truth) while letting the type system catch LOAD-tool shape drift.
 * P1 mitigation from review.
 */
export type LoadResultShape =
  | { toolName: "LOAD_active_sessions"; result: { sessions?: Array<{ id: string; inviteeName?: string; guestEmail?: string }> } }
  | { toolName: "LOAD_preferences"; result: { rules?: Array<{ id: string; label?: string }> } }
  | { toolName: "LOAD_calendar"; result: unknown }
  | { toolName: "LOAD_recent_history"; result: unknown }
  | { toolName: string; result: unknown };

/** Context the runner passes to the check. */
export type GroundingCheckContext = {
  /** Current user message text (always populated). */
  currentUserMessage: string;
  /**
   * 2-turn preload (host + envoy). Populated when ANY declared field on
   * the tool uses `evidenceScope: "recentThread"`. Undefined when stale-trim
   * fired or when the runner didn't load history.
   */
  recentThread?: RecentThread;
  /**
   * This-turn's tool results, accumulated by the runner as the model emits
   * LOAD calls before the write call. Populated when ANY declared field is
   * derivable or has `valueMatch` set.
   */
  thisTurnToolResults?: ReadonlyArray<LoadResultShape>;
};

export type GroundingCheckResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      severity: "advisory" | "strict";
      /** Structured fire record for telemetry (PR-D). */
      fires: ReadonlyArray<{
        toolName: string;
        field: string;
        scope: EvidenceScope | "derivable";
        severity: "advisory" | "strict";
        reason: "missing_evidence" | "missing_value_match" | "missing_derivable_value" | "stale_context";
        emittedValue?: string;
      }>;
    };

// ---------------------------------------------------------------------------
// Per-tool declarations
// ---------------------------------------------------------------------------

export const GROUNDING_DECLARATIONS: Record<string, GroundingDeclaration> = {

  // --- Strict tools (irreversible) ---

  session_cancel: {
    toolName: "session_cancel",
    toolSeverity: "strict",
    fields: [
      {
        field: "sessionId",
        derivable: true,
        valueMatch: "exact", // NEW: value must appear in thisTurnToolResults
        severity: "strict",
      },
    ],
  },

  session_archive_bulk: {
    toolName: "session_archive_bulk",
    toolSeverity: "strict",
    fields: [
      {
        field: "filter",
        derivable: false,
        evidenceScope: "currentMessage", // Bulk archive is irreversible; keep tight.
        patterns: [
          /\b(?:all|bulk|every|everything|clean\s*up|archive\s*all|clear\s*out)\b/i,
          /\b(?:unconfirmed|expired|cancelled)\b/i,
        ],
        severity: "strict",
      },
    ],
  },

  rule_remove: {
    toolName: "rule_remove",
    toolSeverity: "strict",
    fields: [
      {
        field: "id",
        derivable: true,
        valueMatch: "exact", // NEW: value must appear in thisTurnToolResults
        severity: "strict",
      },
    ],
  },

  // primary_link_update — global host config; reversible but high blast radius.
  primary_link_update: {
    toolName: "primary_link_update",
    toolSeverity: "strict",
    fields: [],
  },

  // prefs_update_business_hours — global posture; affects scoring across all links.
  prefs_update_business_hours: {
    toolName: "prefs_update_business_hours",
    toolSeverity: "strict",
    fields: [],
  },

  // prefs_update_timezone — changes how all times render.
  prefs_update_timezone: {
    toolName: "prefs_update_timezone",
    toolSeverity: "strict",
    fields: [
      {
        field: "timezone",
        derivable: false,
        evidenceScope: "currentMessage", // Calendar-wide setting; intentional.
        patterns: [
          /\b(?:timezone|tz|america|europe|asia|africa|pacific|eastern|central|mountain|pst|est|cst|mst|gmt|utc|berlin|london|tokyo|sydney|moved|moving|relocate)\b/i,
        ],
        severity: "strict",
      },
    ],
  },

  // personal_link_create — widened scope + value-match (the cmp2wlgke fix).
  personal_link_create: {
    toolName: "personal_link_create",
    toolSeverity: "advisory",
    fields: [
      {
        field: "inviteeName",
        derivable: false,
        evidenceScope: "recentThread", // NEW: widened — bare-confirm support
        valueMatch: "token",            // NEW: any-token match in scope OR full value in tool results
        patterns: [
          /\b[A-Z][a-z]+\b/,
          /\b(?:with|for)\s+\w+/i,
        ],
        severity: "advisory",
      },
    ],
  },

  session_hold_slot: {
    toolName: "session_hold_slot",
    toolSeverity: "strict",
    fields: [
      {
        field: "sessionId",
        derivable: true,
        valueMatch: "exact", // NEW
        severity: "strict",
      },
      {
        field: "slotStart",
        derivable: false,
        evidenceScope: "recentThread", // NEW: bare-confirm support
        patterns: [
          /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
          /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
          /\b\d{4}-\d{2}-\d{2}\b/,
        ],
        severity: "advisory",
      },
    ],
  },

  // --- Advisory tools (common write ops) ---

  bookable_link_create: {
    toolName: "bookable_link_create",
    toolSeverity: "advisory",
    fields: [
      {
        field: "name",
        derivable: false,
        evidenceScope: "recentThread", // NEW: bare-confirm support
        patterns: [
          /\b(?:music|piano|lessons|office\s*hours|sales|coaching|consult(?:ation)?|tutoring|coffee|intro|sync|interview|workshop|session)\b/i,
          /\b(?:create|new|set up|make|build|add)\s+(?:a\s+)?(?:bookable\s+)?(?:link|template)\b/i,
        ],
        severity: "advisory",
      },
    ],
  },

  session_update_time: {
    toolName: "session_update_time",
    toolSeverity: "advisory",
    fields: [
      {
        field: "dateTime",
        derivable: false,
        evidenceScope: "recentThread", // NEW: bare-confirm support
        patterns: [
          /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
          /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
          /\b\d{4}-\d{2}-\d{2}\b/,
          /\b(?:tomorrow|today|next\s+week|morning|afternoon|evening)\b/i,
        ],
        severity: "advisory",
      },
    ],
  },

  knowledge_write: {
    toolName: "knowledge_write",
    toolSeverity: "advisory",
    fields: [
      {
        field: "persistent",
        derivable: false,
        evidenceScope: "currentMessage", // Memory writes are intentional acts.
        patterns: [
          /\b(?:i'm|i am|my|me|always|usually|generally|prefer|typically|often)\b/i,
          /\b(?:know|remember|note|save|record|update)\b/i,
        ],
        severity: "advisory",
      },
    ],
  },

  // ── Deal-room tools (Phase A.3, 2026-05-11) ──────────────────────────────
  session_set_status: {
    toolName: "session_set_status",
    toolSeverity: "strict",
    fields: [],
  },

  session_confirm_slot: {
    toolName: "session_confirm_slot",
    toolSeverity: "strict",
    fields: [
      {
        field: "dateTime",
        derivable: false,
        evidenceScope: "recentThread", // NEW: confirmation by definition references prior
        patterns: [
          /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
          /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
          /\b\d{4}-\d{2}-\d{2}\b/,
          /\b(?:tomorrow|today|next\s+week|morning|afternoon|evening)\b/i,
          /\b(?:yes|yep|yeah|sure|sounds\s+good|works|book\s+it|let'?s\s+do)\b/i,
        ],
        severity: "strict",
      },
    ],
  },

  session_request_reschedule: {
    toolName: "session_request_reschedule",
    toolSeverity: "strict",
    fields: [
      {
        field: "reason",
        derivable: false,
        evidenceScope: "currentMessage", // Reschedule reasons are said in the moment.
        patterns: [
          /\b(?:reschedul|move\s+it|change\s+the\s+time|push\s+(?:it|back)|cancel\s+and\s+rebook|need\s+(?:to\s+)?(?:move|change))\b/i,
          /\b(?:can'?t\s+make|won'?t\s+work|something\s+came\s+up|conflict)\b/i,
        ],
        severity: "strict",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Concatenate evidence text for a given scope. */
function getEvidenceText(scope: EvidenceScope, ctx: GroundingCheckContext): string {
  if (scope === "currentMessage") return ctx.currentUserMessage;
  // recentThread: current + 2-turn preload (host + envoy). Falls back to
  // currentMessage when staleness trimmed history.
  const parts: string[] = [ctx.currentUserMessage];
  if (ctx.recentThread?.priorUserTurn) parts.push(ctx.recentThread.priorUserTurn);
  if (ctx.recentThread?.priorEnvoyTurn) parts.push(ctx.recentThread.priorEnvoyTurn);
  return parts.join(" \n ");
}

/** Determine whether recentThread is unavailable due to staleness. */
function isRecentThreadStale(ctx: GroundingCheckContext): boolean {
  return ctx.recentThread === undefined;
}

/**
 * Per-tool extractors that pull comparable values out of tool results.
 * Coupled to LOAD tool return shapes — if a LOAD tool's shape changes,
 * the corresponding extractor here must be updated. Unit tests in
 * grounding-check-extractors.test.ts enforce this contract.
 */
function extractDerivedValuesFromToolResults(
  toolName: string,
  field: string,
  results: ReadonlyArray<LoadResultShape>,
): string[] {
  const values: string[] = [];

  // session_cancel.sessionId / session_hold_slot.sessionId →
  // LOAD_active_sessions.sessions[].id
  if (field === "sessionId") {
    for (const r of results) {
      if (r.toolName === "LOAD_active_sessions") {
        const res = r.result as { sessions?: Array<{ id?: string }> };
        for (const s of res.sessions ?? []) {
          if (s.id) values.push(s.id);
        }
      }
    }
  }

  // rule_remove.id → LOAD_preferences.rules[].id
  if (field === "id" && toolName === "rule_remove") {
    for (const r of results) {
      if (r.toolName === "LOAD_preferences") {
        const res = r.result as { rules?: Array<{ id?: string }> };
        for (const rule of res.rules ?? []) {
          if (rule.id) values.push(rule.id);
        }
      }
    }
  }

  return values;
}

/** Serialize all tool results to a flat string for substring search. */
function serializeToolResults(results: ReadonlyArray<LoadResultShape>): string {
  return results.map((r) => {
    try {
      return JSON.stringify(r.result);
    } catch {
      return "";
    }
  }).join(" ");
}

/**
 * Check whether the emitted value appears as evidence under the given
 * value-match strategy. Consults BOTH the evidence-scope text AND the
 * this-turn tool results (resolves the legitimate-name-expansion case).
 */
function valueAppearsInScope(
  strategy: ValueMatchStrategy,
  emittedValue: unknown,
  evidenceText: string,
  toolResults: ReadonlyArray<LoadResultShape> | undefined,
): boolean {
  if (emittedValue === null || emittedValue === undefined) return false;
  const value = String(emittedValue).trim();
  if (value === "") return false;

  const haystackText = evidenceText.toLowerCase();
  const valueLower = value.toLowerCase();
  const toolResultsText = toolResults ? serializeToolResults(toolResults).toLowerCase() : "";

  if (strategy === "exact") {
    // Full value must appear as substring in text OR tool results.
    return haystackText.includes(valueLower) || toolResultsText.includes(valueLower);
  }

  // strategy === "token"
  // Pass if: (a) ANY token from value appears in text, OR
  //          (b) full value appears in tool results.
  if (toolResultsText.includes(valueLower)) return true;
  const tokens = valueLower.split(/\s+/).filter((t) => t.length > 0);
  return tokens.some((t) => haystackText.includes(t));
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Run the grounding check for a tool call before its execute() runs.
 *
 * Signature changed 2026-05-12: third parameter is now `GroundingCheckContext`
 * instead of bare `userMessage` string. Single internal caller is `_exec.ts`;
 * fixture suite updated atomically.
 *
 * Returns { ok: true } if the check passes or no declaration exists for the tool.
 */
export function runGroundingCheck(
  toolName: string,
  toolInput: Record<string, unknown>,
  context: GroundingCheckContext,
): GroundingCheckResult {
  const decl = GROUNDING_DECLARATIONS[toolName];
  if (!decl) return { ok: true };

  const failures: string[] = [];
  const fires: Array<{
    toolName: string;
    field: string;
    scope: EvidenceScope | "derivable";
    severity: "advisory" | "strict";
    reason: "missing_evidence" | "missing_value_match" | "missing_derivable_value" | "stale_context";
    emittedValue?: string;
  }> = [];
  let anyStrict = false;
  let staleContext = false;

  for (const fieldCheck of decl.fields) {
    const value = toolInput[fieldCheck.field];
    const fieldPresent =
      value !== undefined && value !== null && value !== "";
    const emittedValueStr = fieldPresent ? String(value).slice(0, 160) : undefined;

    if (fieldCheck.derivable) {
      // Derivable: field must be present in tool input.
      if (!fieldPresent) {
        if (fieldCheck.severity === "strict") anyStrict = true;
        failures.push(
          `Field "${fieldCheck.field}" is required and must come from LOAD tool output — ` +
          `call LOAD_active_sessions or LOAD_preferences first to get the real value.`,
        );
        fires.push({
          toolName,
          field: fieldCheck.field,
          scope: "derivable",
          severity: fieldCheck.severity,
          reason: "missing_derivable_value",
        });
        continue;
      }

      // Value-match upgrade for derivable fields: value must appear in tool results.
      if (fieldCheck.valueMatch === "exact" && context.thisTurnToolResults) {
        const derivedValues = extractDerivedValuesFromToolResults(
          toolName,
          fieldCheck.field,
          context.thisTurnToolResults,
        );
        const valueLower = String(value).toLowerCase();
        const inResults = derivedValues.some((dv) => dv.toLowerCase() === valueLower);
        if (!inResults) {
          if (fieldCheck.severity === "strict") anyStrict = true;
          failures.push(
            `Field "${fieldCheck.field}" value "${String(value)}" doesn't match any value ` +
            `returned by this turn's LOAD tools. The model may be fabricating an ID — ` +
            `verify the value came from a LOAD result.`,
          );
          fires.push({
            toolName,
            field: fieldCheck.field,
            scope: "derivable",
            severity: fieldCheck.severity,
            reason: "missing_value_match",
            emittedValue: emittedValueStr,
          });
        }
      }
      continue;
    }

    // Non-derivable: evidence in scope text.
    const scope: EvidenceScope = fieldCheck.evidenceScope ?? "currentMessage";

    // Stale-context detection: if field needs recentThread but it's undefined
    // (and current message alone doesn't satisfy), surface distinctive error.
    let scopeIsStale = false;
    if (scope === "recentThread" && isRecentThreadStale(context)) {
      scopeIsStale = true;
    }

    const evidenceText = getEvidenceText(scope, context);

    // Regex shape check
    let shapeOk = true;
    if (fieldCheck.patterns && fieldCheck.patterns.length > 0) {
      shapeOk = fieldCheck.patterns.some((p) => p.test(evidenceText));
    }

    // Value-match check (consults BOTH evidence text AND tool results)
    let valueOk = true;
    if (fieldCheck.valueMatch && fieldPresent) {
      valueOk = valueAppearsInScope(
        fieldCheck.valueMatch,
        value,
        evidenceText,
        context.thisTurnToolResults,
      );
    }

    if (!shapeOk || !valueOk) {
      if (fieldCheck.severity === "strict") anyStrict = true;

      if (scopeIsStale) {
        staleContext = true;
        failures.push(
          `Recent conversation context is stale (>10min); reference for field "${fieldCheck.field}" ` +
          `can't be verified. Ask the host to re-state the value before retrying.`,
        );
        fires.push({
          toolName,
          field: fieldCheck.field,
          scope,
          severity: fieldCheck.severity,
          reason: "stale_context",
          emittedValue: emittedValueStr,
        });
      } else if (!shapeOk) {
        failures.push(
          `Field "${fieldCheck.field}" value "${String(value)}" doesn't appear to be ` +
          `grounded in ${scope === "currentMessage" ? "the user's message" : "recent conversation"}. ` +
          `Verify the user explicitly stated this value before calling this tool.`,
        );
        fires.push({
          toolName,
          field: fieldCheck.field,
          scope,
          severity: fieldCheck.severity,
          reason: "missing_evidence",
          emittedValue: emittedValueStr,
        });
      } else {
        // shapeOk but !valueOk — value-match failure
        failures.push(
          `Field "${fieldCheck.field}" value "${String(value)}" doesn't match anything ` +
          `mentioned in ${scope === "currentMessage" ? "the user's message" : "recent conversation"} ` +
          `or in this turn's LOAD results. The value may be fabricated.`,
        );
        fires.push({
          toolName,
          field: fieldCheck.field,
          scope,
          severity: fieldCheck.severity,
          reason: "missing_value_match",
          emittedValue: emittedValueStr,
        });
      }
    }
  }

  if (failures.length === 0) return { ok: true };

  const severity = anyStrict || decl.toolSeverity === "strict" ? "strict" : "advisory";
  const prefix =
    staleContext
      ? `[GROUNDING CHECK — ${toolName}, stale context] `
      : severity === "strict"
        ? `[GROUNDING ERROR — ${toolName}] This is an irreversible operation. `
        : `[GROUNDING CHECK — ${toolName}] `;

  return {
    ok: false,
    error: prefix + failures.join(" | "),
    severity,
    fires,
  };
}
