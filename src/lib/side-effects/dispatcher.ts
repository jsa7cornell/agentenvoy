/**
 * Central side-effect dispatcher.
 *
 * All outbound effects in the app flow through `dispatch()`. The dispatcher:
 *   1. Resolves the EffectMode from env (EFFECT_MODE_<KIND>) with a safe default.
 *   2. Routes to the appropriate handler.
 *   3. Writes a SideEffectLog row — ALWAYS, even for suppressed/dryrun/skipped.
 *   4. Returns a typed SideEffectResult<K>.
 *
 * See RISK-MANAGEMENT.md for the full methodology. Adding a new kind = add
 * a handler + register it here + set EFFECT_MODE_<KIND> vars per env.
 */

import { prisma } from "@/lib/prisma";
import type {
  SideEffect,
  EffectKind,
  EffectMode,
  SideEffectResult,
} from "./types";
// Individual effect type imports (EmailSendEffect, CalendarCreateEventEffect,
// etc.) live only in the `export type { ... } from "./types"` re-export block
// below — they aren't referenced locally, so lint would reject a top-level
// import. Phase 2/3 handlers will land their own imports inside their handler
// files, not here.
import {
  handleEmail,
  summarizeEmailTarget,
  type EmailHandlerOutcome,
} from "./handlers/email";
import {
  handleCalendarCreateEvent,
  handleCalendarCreateHold,
  handleCalendarDeleteEvent,
  handleCalendarUpdateEvent,
  summarizeCalendarCreateEventTarget,
  summarizeCalendarCreateHoldTarget,
  summarizeCalendarDeleteEventTarget,
  summarizeCalendarUpdateEventTarget,
  type CalendarHandlerOutcome,
} from "./handlers/calendar";

// ─────────────────────────────────────────────────────────────────────────────
// Env resolution
// ─────────────────────────────────────────────────────────────────────────────

const VALID_MODES: EffectMode[] = ["live", "allowlist", "log", "dryrun", "off"];

/**
 * Per-kind env var names — one place to grep. Partial so Phase 2 / Phase 3
 * can land handlers without pre-declaring every env var here. Kinds without
 * an entry fall back to the safe default in `resolveMode`.
 */
const MODE_ENV_VAR: Partial<Record<EffectKind, string>> = {
  "email.send": "EFFECT_MODE_EMAIL",
  // All three calendar kinds share one env var for simplicity —
  // there's no realistic scenario for e.g. live event-create + dryrun hold-create.
  "calendar.create_event": "EFFECT_MODE_CALENDAR",
  "calendar.create_hold": "EFFECT_MODE_CALENDAR",
  "calendar.delete_event": "EFFECT_MODE_CALENDAR",
  "calendar.update_event": "EFFECT_MODE_CALENDAR",
  // "mcp.callback":          "EFFECT_MODE_MCP_CALLBACK", (Phase 3)
};

/**
 * Default mode when the env var is missing. These defaults prioritize safety:
 * absent config = don't reach the outside world. Production deploys should
 * always set these explicitly — Phase 4 adds a build-time check for that.
 * Any kind without an explicit entry falls back to "log" via resolveMode.
 */
const DEFAULT_MODE: Partial<Record<EffectKind, EffectMode>> = {
  "email.send": "log",
  // Calendar create_* default to `dryrun` (not `log`) because upstream
  // confirm + hold flows expect a plausible eventId + meetLink to continue.
  // `dryrun` returns synthetic values; `log` returns nulls which break the UI.
  "calendar.create_event": "dryrun",
  "calendar.create_hold": "dryrun",
  // Delete has no useful return — `log` is fine as the safe default.
  "calendar.delete_event": "log",
  // Update defaults to `log` (not `dryrun`) — we don't synthesize a fake patched event.
  "calendar.update_event": "log",
};

/** Universal safe fallback for kinds that haven't declared their own default. */
const UNIVERSAL_FALLBACK_MODE: EffectMode = "log";

export function resolveMode(kind: EffectKind): EffectMode {
  const envVar = MODE_ENV_VAR[kind];
  const fallback = DEFAULT_MODE[kind] ?? UNIVERSAL_FALLBACK_MODE;
  if (!envVar) return fallback;
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const mode = raw.toLowerCase() as EffectMode;
  if (!VALID_MODES.includes(mode)) {
    console.warn(
      `[side-effects] invalid ${envVar}="${raw}", falling back to ${fallback}`,
    );
    return fallback;
  }
  return mode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload scrubbing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the SideEffectLog.payload JSON. We store enough for debugging but
 * never secrets. For email: store everything EXCEPT the full HTML body
 * (which is large and can contain tokens in links). Instead, we store the
 * subject, recipient list, a body-length, and a short body snippet.
 */
function scrubPayload(effect: SideEffect): Record<string, unknown> {
  switch (effect.kind) {
    case "email.send": {
      const { to, subject, html, from, replyTo } = effect;
      return {
        kind: "email.send",
        to: Array.isArray(to) ? to : [to],
        subject,
        from: from ?? null,
        replyTo: replyTo ?? null,
        htmlBytes: html.length,
        htmlSnippet: html.slice(0, 280),
      };
    }
    case "calendar.create_event": {
      return {
        kind: "calendar.create_event",
        userId: effect.userId,
        summary: effect.summary,
        attendees: effect.attendeeEmails,
        startTime: effect.startTime.toISOString(),
        endTime: effect.endTime.toISOString(),
        addMeetLink: !!effect.addMeetLink,
        sessionId: effect.sessionId ?? null,
        sendUpdatesOverride: effect.sendUpdatesOverride ?? null,
        descriptionBytes: effect.description?.length ?? 0,
      };
    }
    case "calendar.create_hold": {
      return {
        kind: "calendar.create_hold",
        userId: effect.userId,
        summary: effect.summary,
        startTime: effect.startTime.toISOString(),
        endTime: effect.endTime.toISOString(),
        descriptionBytes: effect.description?.length ?? 0,
      };
    }
    case "calendar.delete_event": {
      return {
        kind: "calendar.delete_event",
        userId: effect.userId,
        eventId: effect.eventId,
        notifyAttendees: !!effect.notifyAttendees,
      };
    }
    case "calendar.update_event": {
      return {
        kind: "calendar.update_event",
        userId: effect.userId,
        eventId: effect.eventId,
        sessionId: effect.sessionId,
        changes: {
          summary: effect.changes.summary,
          location: effect.changes.location,
          startTime: effect.changes.startTime?.toISOString(),
          endTime: effect.changes.endTime?.toISOString(),
          descriptionBytes: effect.changes.description?.length ?? 0,
        },
        notifyAttendees: !!effect.notifyAttendees,
        sendUpdatesOverride: effect.sendUpdatesOverride ?? null,
      };
    }
    default:
      // Unimplemented kind — record the kind only for audit, strip the rest
      // (we don't know what's safe to log for an unknown shape).
      return { kind: (effect as SideEffect).kind, unhandled: true };
  }
}

function summarizeTarget(effect: SideEffect): string {
  switch (effect.kind) {
    case "email.send":
      return summarizeEmailTarget(effect);
    case "calendar.create_event":
      return summarizeCalendarCreateEventTarget(effect);
    case "calendar.create_hold":
      return summarizeCalendarCreateHoldTarget(effect);
    case "calendar.delete_event":
      return summarizeCalendarDeleteEventTarget(effect);
    case "calendar.update_event":
      return summarizeCalendarUpdateEventTarget(effect);
    default:
      return `(unhandled kind: ${(effect as SideEffect).kind})`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler routing
// ─────────────────────────────────────────────────────────────────────────────

/** Superset shape covering every possible handler output. */
interface HandlerOutcomeBase {
  status: SideEffectResult["status"];
  effectiveMode: EffectMode;
  /** email.send only */
  providerMessageId?: string;
  /** calendar.create_event, calendar.create_hold */
  eventId?: string | null;
  htmlLink?: string | null;
  /** calendar.create_event only */
  meetLink?: string | null;
  error?: string;
}

async function runHandler(
  effect: SideEffect,
  mode: EffectMode,
): Promise<HandlerOutcomeBase> {
  switch (effect.kind) {
    case "email.send": {
      const outcome: EmailHandlerOutcome = await handleEmail(effect, mode);
      return outcome;
    }
    case "calendar.create_event": {
      const outcome: CalendarHandlerOutcome = await handleCalendarCreateEvent(effect, mode);
      return outcome;
    }
    case "calendar.create_hold": {
      const outcome: CalendarHandlerOutcome = await handleCalendarCreateHold(effect, mode);
      return outcome;
    }
    case "calendar.delete_event": {
      const outcome: CalendarHandlerOutcome = await handleCalendarDeleteEvent(effect, mode);
      return outcome;
    }
    case "calendar.update_event": {
      const outcome: CalendarHandlerOutcome = await handleCalendarUpdateEvent(effect, mode);
      return outcome;
    }
    default:
      // Kind is declared in types.ts but has no handler yet (Phase 2+ work).
      // Fail loudly in the return value — caller gets status:"failed" +
      // explanatory error — rather than throwing, so callers don't break.
      return {
        status: "failed",
        effectiveMode: mode,
        error: `No handler registered for kind "${(effect as SideEffect).kind}". This kind is declared in types.ts but its handler hasn't been implemented yet.`,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch an outbound side effect. Always returns — never throws for handler
 * errors; the result's `status: "failed"` + `error` field carry failure info.
 * Throws only for dispatcher-level problems (e.g. DB write for the log fails),
 * which are catastrophic and should surface.
 */
/**
 * Kinds that should ALWAYS run in `live` mode in production. If any of these
 * resolve to a non-live mode while `NODE_ENV === "production"`, that's a
 * config miss (missing `EFFECT_MODE_*` env var) — we log a RouteError so it
 * surfaces on `/admin/failures` the first time it happens, instead of
 * silently no-op'ing every confirmation for days. Throttled to one alert
 * per kind per process lifetime so we don't spam the failure log.
 *
 * Incident context: 2026-04-17 EFFECT_MODE_CALENDAR was never set in Vercel
 * production, so the dispatcher defaulted to `dryrun` and every confirmed
 * meeting created a synthetic event instead of a real GCal invite. The
 * miss went undetected for at least half a day. This guard catches that
 * exact class of bug.
 */
const MUST_BE_LIVE_IN_PROD: EffectKind[] = [
  "email.send",
  "calendar.create_event",
  "calendar.create_hold",
  "calendar.update_event",
  // calendar.delete_event intentionally omitted — `log` is the documented
  // safe default; missing env var there is less catastrophic.
];
const prodModeAlertsFired = new Set<EffectKind>();

/** Test-only — reset the per-process alert dedupe so individual tests can
 *  exercise the "alert fires once" behavior independently. */
export function __resetProdModeAlertsForTests(): void {
  prodModeAlertsFired.clear();
}

export function alertIfProdModeMisconfigured(kind: EffectKind, mode: EffectMode): void {
  if (process.env.NODE_ENV !== "production") return;
  if (!MUST_BE_LIVE_IN_PROD.includes(kind)) return;
  if (mode === "live" || mode === "allowlist") return;
  if (prodModeAlertsFired.has(kind)) return;
  prodModeAlertsFired.add(kind);
  const envVar = MODE_ENV_VAR[kind];
  const message =
    `[side-effects] CRITICAL: ${kind} is resolving to "${mode}" in production. ` +
    `Set ${envVar}=live in Vercel Production env vars. All ${kind} calls are ` +
    `currently no-op or synthetic — users are not receiving real side effects.`;
  console.error(message);
  // Fire-and-forget RouteError write so this surfaces on /admin/failures.
  // Lazy import to avoid a circular dep between route-error.ts and dispatcher.ts.
  import("@/lib/route-error")
    .then(({ logRouteError }) => {
      logRouteError({
        route: "side-effects/dispatcher",
        method: "dispatch",
        statusCode: 500,
        error: new Error(message),
        context: { kind, mode, envVar: envVar ?? null },
      });
    })
    .catch(() => {
      // If even the route-error import fails, we already console.error'd —
      // don't compound the problem.
    });
}

export async function dispatch<K extends EffectKind>(
  effect: SideEffect & { kind: K },
): Promise<SideEffectResult<K>> {
  const kind: EffectKind = effect.kind;
  const mode = resolveMode(kind);
  alertIfProdModeMisconfigured(kind, mode);

  let outcome: HandlerOutcomeBase;
  try {
    outcome = await runHandler(effect, mode);
  } catch (err) {
    outcome = {
      status: "failed",
      effectiveMode: mode,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Persist the audit row. This is the ONE thing we don't swallow —
  // if the log write fails, surface it, because an un-logged side effect
  // is worse than a failed one.
  const log = await prisma.sideEffectLog.create({
    data: {
      kind,
      mode: outcome.effectiveMode,
      status: outcome.status,
      targetSummary: summarizeTarget(effect),
      payload: scrubPayload(effect) as object,
      contextJson:
        "context" in effect && effect.context
          ? (effect.context as object)
          : undefined,
      // Prefer email's providerMessageId; fall back to calendar's eventId —
      // both are "what the external system gave us back."
      providerRef: outcome.providerMessageId ?? outcome.eventId ?? null,
      error: outcome.error ?? null,
    },
    select: { id: true },
  });

  const result = {
    kind,
    status: outcome.status,
    mode: outcome.effectiveMode,
    logId: log.id,
    ...(outcome.providerMessageId !== undefined && { providerMessageId: outcome.providerMessageId }),
    ...(outcome.eventId !== undefined && { eventId: outcome.eventId }),
    ...(outcome.htmlLink !== undefined && { htmlLink: outcome.htmlLink }),
    ...(outcome.meetLink !== undefined && { meetLink: outcome.meetLink }),
    ...(outcome.error ? { error: outcome.error } : {}),
  } as SideEffectResult<K>;

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Terminal statuses that count as "we already tried — don't try again" for
 * the idempotency gate. `skipped` (the `off` kill-switch) is deliberately
 * excluded so that turning the kill-switch back on re-enables delivery.
 */
const GATE_TERMINAL_STATUSES = ["sent", "suppressed", "dryrun", "failed"] as const;

/**
 * Has a dispatch already been recorded for the given (kind, userId, purpose)
 * triple? Reads from SideEffectLog — the authoritative record of every
 * dispatch attempt.
 *
 * Replaces per-email stamp columns on the User model (e.g. the deprecated
 * `welcomeEmailSentAt`). Pattern: call this at the top of a
 * `dispatchXxxOnce(userId)` helper and bail early when it returns true.
 *
 * Index: partial expression index
 * `SideEffectLog_kind_user_purpose_idx` on
 * `(kind, (contextJson->>'userId'), (contextJson->>'purpose'))`
 * WHERE status IN (sent, suppressed, dryrun, failed) — keeps this lookup
 * O(log n) even as the log grows.
 *
 * Retention note: the gate assumes non-skipped rows matching a user/purpose
 * are never pruned. If a retention policy is added later, gate-relevant
 * rows must be exempt — otherwise the gate goes stale and re-fires.
 */
export async function hasDispatchedFor(params: {
  kind: EffectKind;
  userId: string;
  purpose: string;
}): Promise<boolean> {
  const { kind, userId, purpose } = params;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "SideEffectLog"
    WHERE kind = ${kind}
      AND status IN ('sent', 'suppressed', 'dryrun', 'failed')
      AND "contextJson"->>'userId' = ${userId}
      AND "contextJson"->>'purpose' = ${purpose}
    LIMIT 1
  `;
  return rows.length > 0;
}

/** Exported for tests only — matches the statuses used in the raw SQL above. */
export const __GATE_TERMINAL_STATUSES_FOR_TESTS = GATE_TERMINAL_STATUSES;

// Re-export types for callers.
export type {
  SideEffect,
  SideEffectResult,
  EffectKind,
  EffectMode,
  EmailSendEffect,
  CalendarCreateEventEffect,
  CalendarCreateHoldEffect,
  CalendarDeleteEventEffect,
  CalendarUpdateEventEffect,
} from "./types";
/** Convenience alias — callers can do `dispatch({ kind: "email.send", ... })`. */
export type DispatchInput = SideEffect;
