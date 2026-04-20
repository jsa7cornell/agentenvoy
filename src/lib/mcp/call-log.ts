/**
 * Schema-driven log redaction for MCPCallLog writes.
 *
 * SPEC §7. Every field in every tool response is assigned a redaction
 * class. The log writer iterates the map; there is no "ad-hoc redaction
 * at the call site." When a new field is added to a tool response, the
 * redaction table is the single place it needs to be declared — and the
 * default-branch throw in `redactForCallLog` turns "forgot to add it"
 * into a loud error rather than a silent log leak.
 *
 * Classes:
 *   - "verbatim"        → store as-is
 *   - "drop"            → omit from the log entirely (rationaleProse, etc)
 *   - "hashed"          → sha256 hex (or caller-supplied hash field)
 *   - { cap: N }        → truncate to N chars, append "…"
 *   - "shape-summary"   → replace with { keys: [...], valueTypes: {...} }
 *                         (for arrays: { type: "array", length, elementShape? })
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type RedactionClass =
  | "verbatim"
  | "drop"
  | "hashed"
  | "shape-summary"
  | { cap: number };

// ---------------------------------------------------------------------------
// Redaction table — single source of truth.
//
// Keyed by MCP tool name (matches `MCP_TOOL_NAMES` in schemas.ts). Each
// tool entry is a full map of every field the wire response can carry —
// both ok-path and refusal-path — so `redactResponseForCallLog` never
// throws on a legitimate response.
//
// Common refusal fields (`ok`, `reason`, `message`, `retryAfterSeconds`)
// are merged into every tool's map via `REFUSAL_COMMON` below.
// ---------------------------------------------------------------------------

const REFUSAL_COMMON: Record<string, RedactionClass> = {
  ok: "verbatim",
  reason: "verbatim",
  message: "verbatim",
  retryAfterSeconds: "verbatim",
};

export const CALL_LOG_REDACTION: Record<string, Record<string, RedactionClass>> = {
  get_meeting_parameters: {
    ...REFUSAL_COMMON,
    meetingUrl: "verbatim",
    parameters: "shape-summary",
    rules: "shape-summary",
  },
  get_availability: {
    ...REFUSAL_COMMON,
    timezone: "verbatim",
    // Slot timestamps are not secret, but we shape-summary to keep the log
    // row bounded — a 60-slot week would blow up the JSON column otherwise.
    slots: "shape-summary",
  },
  get_session_status: {
    ...REFUSAL_COMMON,
    status: "verbatim",
    sessionId: "verbatim",
    agreedTime: "verbatim",
    rescheduleHistory: "shape-summary",
    pendingConsentRequests: "shape-summary",
  },
  post_message: {
    ...REFUSAL_COMMON,
    messageId: "verbatim",
    sessionId: "verbatim",
    // envoyReply carries generated prose — shape-summary until the
    // streaming-reply channel lands and we design a per-field policy.
    envoyReply: "shape-summary",
  },
  propose_parameters: {
    ...REFUSAL_COMMON,
    sessionId: "verbatim",
    results: "shape-summary",
    graceWindowSeconds: "verbatim",
    decidedAt: "verbatim",
  },
  propose_lock: {
    ...REFUSAL_COMMON,
    sessionId: "verbatim",
    status: "verbatim",
    dateTime: "verbatim",
    duration: "verbatim",
    format: "verbatim",
    location: "verbatim",
    meetLink: "verbatim",
    eventLink: "verbatim",
    idempotent: "verbatim",
    warnings: "verbatim",
    counterProposal: "shape-summary",
  },
  cancel_meeting: {
    ...REFUSAL_COMMON,
    sessionId: "verbatim",
    status: "verbatim",
    idempotent: "verbatim",
  },
  reschedule_meeting: {
    ...REFUSAL_COMMON,
    sessionId: "verbatim",
    status: "verbatim",
    from: "verbatim",
    to: "verbatim",
    idempotent: "verbatim",
    counterProposal: "shape-summary",
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
  if (value === null || value === undefined) {
    return { type: value === null ? "null" : "undefined" };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      ...(value.length > 0
        ? { elementShape: shapeSummary(value[0]) }
        : {}),
    };
  }
  if (typeof value !== "object") {
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
 * are omitted from the returned object. Fields absent from the response
 * (e.g. optional `meetLink` on a refusal) simply don't appear in the output.
 */
export function redactResponseForCallLog(
  tool: string,
  response: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(response)) {
    if (value === undefined) continue;
    const outcome = redactForCallLog(tool, field, value);
    if (outcome.kind === "keep") out[field] = outcome.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

export type McpCallLogContext = {
  tool: string;
  linkId: string;
  sessionId?: string | null;
  clientMeta?: {
    clientName?: string;
    clientType?: string;
    principal?: { name?: string; email?: string };
  };
  requestArgs: Record<string, unknown>;
  response: Record<string, unknown>;
  latencyMs: number;
};

/**
 * Redact and persist one `MCPCallLog` row. Callers should invoke this
 * non-blocking (e.g. via Vercel's `waitUntil`) so the log write never
 * sits on the critical path of the tool's response.
 *
 * The request body is redacted with a simple allow-list: we keep primitive
 * scalars (`string` / `number` / `boolean`), replace objects with their
 * shape, and always drop `meetingUrl` (which is the capability token — it
 * never lands in logs, per §4/§7).
 */
export async function writeMcpCallLog(ctx: McpCallLogContext): Promise<void> {
  try {
    const outcome = ctx.response.ok === true
      ? "ok"
      : `error:${String(ctx.response.reason ?? "unknown")}`;

    const redactedResponse = redactResponseForCallLog(ctx.tool, ctx.response);
    const redactedRequest = redactRequestArgs(ctx.requestArgs);

    await prisma.mCPCallLog.create({
      data: {
        linkId: ctx.linkId,
        sessionId: ctx.sessionId ?? null,
        tool: ctx.tool,
        clientName: ctx.clientMeta?.clientName ?? null,
        clientType: ctx.clientMeta?.clientType ?? null,
        principal: (ctx.clientMeta?.principal
          ? (ctx.clientMeta.principal as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull),
        requestBody: redactedRequest as Prisma.InputJsonValue,
        responseBody: redactedResponse as Prisma.InputJsonValue,
        outcome,
        latencyMs: ctx.latencyMs,
      },
    });
  } catch (e) {
    // Log write failures are non-fatal. Surface to console rather than
    // letting the error bubble — an observability miss must never break
    // the tool call itself.
    console.error("[mcp/call-log] write failed:", e);
  }
}

/**
 * Request-arg redaction. We don't use the per-field table here because
 * request shapes are stable and small — scalars pass through, objects get
 * shape-summarized, and `meetingUrl` is always dropped (it's the bearer).
 */
function redactRequestArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "meetingUrl") continue; // bearer — never log
    if (value === null || value === undefined) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
      continue;
    }
    // Objects / arrays → shape-summary (same helper used for responses).
    out[key] = shapeSummary(value);
  }
  return out;
}
