/**
 * Layer 2 — per-tool grounding check (pre-execute gate).
 *
 * Generalizes `requiredFieldExtractionCheck` (recalibrate-only) to a
 * per-tool gate on every unified-agent write tool.
 *
 * How it works:
 *   1. Each write tool registers a GroundingDeclaration listing which input
 *      fields require evidence from the conversation.
 *   2. Before `execute` runs, `runGroundingCheck()` validates the model's
 *      tool call against the declaration.
 *   3. Severity "advisory": returns an error string to the model so it can
 *      reconsider (the AI SDK propagates tool errors back as tool-result
 *      content for the next step).
 *   4. Severity "strict": same mechanism, but the error message is stronger
 *      and the field is flagged in telemetry. Reserved for irreversible ops.
 *
 * The check is deliberately lightweight — lexical/structural, not semantic.
 * False positives cost a model retry; they do not drop real user intent.
 * Severity "advisory" means a false positive is non-blocking.
 *
 * Strict tools (irreversible): link_cancel, session_archive_bulk, rule_remove,
 * session_hold_slot. These require at least one structural evidence check
 * (e.g. an explicit session/link ID present in the tool call).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GroundingFieldCheck = {
  /** The field on the tool's inputSchema to check. */
  field: string;
  /**
   * Whether the field can be derived from context (LOAD_ tool output, prior
   * turns) vs must appear explicitly in the current user message.
   * derivable = true  → presence in the tool call args is sufficient evidence.
   * derivable = false → must appear in the current user message text.
   */
  derivable: boolean;
  /** Regex patterns that confirm user-message evidence (used when !derivable). */
  patterns?: readonly RegExp[];
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

export type GroundingCheckResult =
  | { ok: true }
  | { ok: false; error: string; severity: "advisory" | "strict" };

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
        derivable: true, // must come from LOAD_active_sessions output
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
        // User must have said something like "archive all", "clean up", "bulk"
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
        derivable: true, // ID must come from LOAD_preferences output
        severity: "strict",
      },
    ],
  },

  // primary_link_update — touches global host config; reversible but high blast radius.
  primary_link_update: {
    toolName: "primary_link_update",
    toolSeverity: "strict",
    fields: [], // No specific field gate — declaration alone makes the call strict-marked in telemetry.
  },

  // prefs_update_timezone — changes how all times render across the system.
  prefs_update_timezone: {
    toolName: "prefs_update_timezone",
    toolSeverity: "strict",
    fields: [
      {
        field: "timezone",
        derivable: false,
        patterns: [
          /\b(?:timezone|tz|america|europe|asia|africa|pacific|eastern|central|mountain|pst|est|cst|mst|gmt|utc|berlin|london|tokyo|sydney|moved|moving|relocate)\b/i,
        ],
        severity: "strict",
      },
    ],
  },

  // personal_link_create with autoConfirm — irreversible calendar write.
  // Strict only when autoConfirm is set; otherwise advisory.
  // The declaration uses field-level severity so the check evaluates per call.
  personal_link_create: {
    toolName: "personal_link_create",
    toolSeverity: "advisory",
    fields: [
      {
        field: "inviteeName",
        derivable: false,
        // The user must name the guest somewhere in the message.
        // Heuristic: presence of any capitalized word longer than 1 char,
        // OR explicit deferral phrases. We accept liberally; falls advisory.
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
        severity: "strict",
      },
      {
        field: "slotStart",
        derivable: false,
        patterns: [
          // Time expressions: "2pm", "14:00", "Tuesday at 3"
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
        // User must have named the bookable link or its purpose
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
        // At least one of persistent/situational/currentLocation must be present
        field: "persistent",
        derivable: false,
        patterns: [
          /\b(?:i'm|i am|my|me|always|usually|generally|prefer|typically|often)\b/i,
          /\b(?:know|remember|note|save|record|update)\b/i,
        ],
        severity: "advisory",
      },
    ],
  },

  // ── Deal-room tools (Phase A.3, 2026-05-11) ──────────────────────────────
  // session_set_status — strict at the tool level (status changes are session-
  // state mutations with SPEC §2.3.1 invariant clearing) but no per-field gate.
  // The tool's z.enum already constrains status to the closed set; no further
  // grounding signal needed beyond presence.
  session_set_status: {
    toolName: "session_set_status",
    toolSeverity: "strict",
    fields: [],
  },

  // session_confirm_slot — STRICT: irreversible. Writes a GCal event + sends
  // an invite. The dateTime field must have time-shape evidence in the
  // conversation (a slot was offered or the guest named a time); accept either
  // direct clock-time language or "yes/that works" agreement following a slot
  // offer earlier in the conversation. Pattern matches the legacy
  // session_update_time gate at line 198 of this file.
  session_confirm_slot: {
    toolName: "session_confirm_slot",
    toolSeverity: "strict",
    fields: [
      {
        field: "dateTime",
        derivable: false,
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

  // session_request_reschedule — STRICT: deletes the live GCal event +
  // notifies attendees. Requires either an explicit reschedule verb or a
  // clear "this isn't going to work" signal in the user message.
  session_request_reschedule: {
    toolName: "session_request_reschedule",
    toolSeverity: "strict",
    fields: [
      {
        field: "reason",
        derivable: false,
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
// Executor
// ---------------------------------------------------------------------------

/**
 * Run the grounding check for a tool call before its execute() runs.
 *
 * @param toolName  - The tool being called.
 * @param toolInput - The model's input to the tool.
 * @param userMessage - The current user turn text.
 *
 * Returns { ok: true } if the check passes or no declaration exists for the tool.
 */
export function runGroundingCheck(
  toolName: string,
  toolInput: Record<string, unknown>,
  userMessage: string,
): GroundingCheckResult {
  const decl = GROUNDING_DECLARATIONS[toolName];
  if (!decl) return { ok: true };

  const failures: string[] = [];
  let anyStrict = false;

  for (const fieldCheck of decl.fields) {
    const value = toolInput[fieldCheck.field];
    const fieldPresent =
      value !== undefined && value !== null && value !== "";

    if (fieldCheck.derivable) {
      // Derivable: the field must just be present (came from LOAD_ output).
      if (!fieldPresent) {
        if (fieldCheck.severity === "strict") anyStrict = true;
        failures.push(
          `Field "${fieldCheck.field}" is required and must come from LOAD tool output — ` +
          `call LOAD_active_sessions or LOAD_preferences first to get the real value.`,
        );
      }
      continue;
    }

    // Non-derivable: must have evidence in the current user message.
    if (fieldCheck.patterns && fieldCheck.patterns.length > 0) {
      const evidenced = fieldCheck.patterns.some((p) => p.test(userMessage));
      if (!evidenced) {
        if (fieldCheck.severity === "strict") anyStrict = true;
        failures.push(
          `Field "${fieldCheck.field}" value "${String(value)}" doesn't appear to be ` +
          `grounded in the user's message. Verify the user explicitly stated this value ` +
          `before calling this tool.`,
        );
      }
    }
  }

  if (failures.length === 0) return { ok: true };

  const severity = anyStrict || decl.toolSeverity === "strict" ? "strict" : "advisory";
  const prefix =
    severity === "strict"
      ? `[GROUNDING ERROR — ${toolName}] This is an irreversible operation. `
      : `[GROUNDING CHECK — ${toolName}] `;

  return {
    ok: false,
    error: prefix + failures.join(" | "),
    severity,
  };
}
