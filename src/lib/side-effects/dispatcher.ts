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
  EmailSendEffect,
} from "./types";
import {
  handleEmail,
  summarizeEmailTarget,
  type EmailHandlerOutcome,
} from "./handlers/email";

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
  // "calendar.create_event": "EFFECT_MODE_CALENDAR",  (Phase 2)
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
    default:
      return `(unhandled kind: ${(effect as SideEffect).kind})`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler routing
// ─────────────────────────────────────────────────────────────────────────────

interface HandlerOutcomeBase {
  status: SideEffectResult["status"];
  effectiveMode: EffectMode;
  providerMessageId?: string;
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
export async function dispatch<K extends EffectKind>(
  effect: SideEffect & { kind: K },
): Promise<SideEffectResult<K>> {
  const kind: EffectKind = effect.kind;
  const mode = resolveMode(kind);

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
      providerRef: outcome.providerMessageId ?? null,
      error: outcome.error ?? null,
    },
    select: { id: true },
  });

  const result = {
    kind,
    status: outcome.status,
    mode: outcome.effectiveMode,
    logId: log.id,
    ...(outcome.providerMessageId
      ? { providerMessageId: outcome.providerMessageId }
      : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  } as SideEffectResult<K>;

  return result;
}

// Re-export types for callers.
export type { SideEffect, SideEffectResult, EffectKind, EffectMode } from "./types";
/** Convenience alias — callers can do `dispatch({ kind: "email.send", ... })` using the EmailSendEffect shape. */
export type DispatchInput = SideEffect;
export type { EmailSendEffect };
