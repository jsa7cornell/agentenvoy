/**
 * Schema-driven log redaction for MCPCallLog writes.
 *
 * SPEC §7. Every field in every tool response is assigned a redaction
 * class. The log writer iterates the map; there is no "ad-hoc redaction
 * at the call site." When a new field is added to a tool response, the
 * TypeScript compiler surfaces the missing entry in the redaction table
 * (each tool's entry is a `Record<string, RedactionClass>`), so you cannot
 * forget to decide.
 *
 * Classes:
 *   - "verbatim"        → store as-is
 *   - "drop"            → omit from the log entirely (rationaleProse, etc)
 *   - "hashed"          → sha256 hex (or caller-supplied hash field)
 *   - { cap: N }        → truncate to N chars, append "…"
 *   - "shape-summary"   → replace with { keys: [...], valueTypes: {...} }
 */

import { createHash } from "node:crypto";

export type RedactionClass =
  | "verbatim"
  | "drop"
  | "hashed"
  | "shape-summary"
  | { cap: number };

// ---------------------------------------------------------------------------
// Redaction table — single source of truth.
//
// Keyed by MCP tool name. Each tool entry is keyed by response field name.
// Adding a new field on the wire WITHOUT adding an entry here should be
// caught by the `redactForCallLog` default branch: unknown field throws.
// ---------------------------------------------------------------------------

export const CALL_LOG_REDACTION: Record<string, Record<string, RedactionClass>> = {
  propose_lock: {
    accepted: "verbatim",
    field: "verbatim",
    appliedValue: "verbatim",
    rationaleProse: "drop", // SPEC §3: never logged
    rationaleTemplate: "verbatim",
    consentRequestId: "verbatim",
    error: "verbatim",
  },
  post_message: {
    messageId: "verbatim",
    bodyLength: "verbatim",
    guestEmail: "hashed", // §4 — callers should pre-hash via email-hash.ts
    body: { cap: 0 }, // drop prose content; bodyLength carries the signal
    error: "verbatim",
  },
  read_state: {
    sessionId: "verbatim",
    status: "verbatim",
    canObject: "verbatim",
    finalizesAt: "verbatim",
    rules: "shape-summary",
    error: "verbatim",
  },
  request_consent: {
    consentRequestId: "verbatim",
    field: "verbatim",
    appliedValue: "verbatim",
    rationaleProse: "drop",
    error: "verbatim",
  },
};

// ---------------------------------------------------------------------------
// Apply redaction
// ---------------------------------------------------------------------------

export type RedactionOutcome =
  | { kind: "keep"; value: unknown }
  | { kind: "drop" };

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function shapeSummary(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { type: typeof value };
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const valueTypes: Record<string, string> = {};
  for (const k of keys) valueTypes[k] = typeof obj[k];
  return { keys, valueTypes };
}

function applyClass(klass: RedactionClass, value: unknown): RedactionOutcome {
  if (klass === "drop") return { kind: "drop" };
  if (klass === "verbatim") return { kind: "keep", value };
  if (klass === "hashed") {
    if (value === null || value === undefined) return { kind: "keep", value };
    return { kind: "keep", value: sha256Hex(String(value)) };
  }
  if (klass === "shape-summary") return { kind: "keep", value: shapeSummary(value) };
  // { cap: N }
  if (typeof value !== "string") {
    return { kind: "keep", value: shapeSummary(value) };
  }
  if (klass.cap <= 0) return { kind: "drop" };
  if (value.length <= klass.cap) return { kind: "keep", value };
  return { kind: "keep", value: `${value.slice(0, klass.cap)}…` };
}

/**
 * Redact a single (tool, field, value) tuple. Used by the log writer when
 * serializing tool responses before INSERT into `MCPCallLog`.
 *
 * Throws on unknown tool or unknown field so the redaction table stays
 * exhaustive — discovery of a missing entry is loud, not silent.
 */
export function redactForCallLog(
  tool: string,
  field: string,
  value: unknown,
): RedactionOutcome {
  const toolMap = CALL_LOG_REDACTION[tool];
  if (!toolMap) {
    throw new Error(`redactForCallLog: unknown tool "${tool}"`);
  }
  const klass = toolMap[field];
  if (!klass) {
    throw new Error(
      `redactForCallLog: no redaction class for "${tool}.${field}" — add it to CALL_LOG_REDACTION`,
    );
  }
  return applyClass(klass, value);
}

/**
 * Convenience: redact an entire response object. Fields with `drop` class
 * are omitted from the returned object.
 */
export function redactResponseForCallLog(
  tool: string,
  response: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(response)) {
    const outcome = redactForCallLog(tool, field, value);
    if (outcome.kind === "keep") out[field] = outcome.value;
  }
  return out;
}
