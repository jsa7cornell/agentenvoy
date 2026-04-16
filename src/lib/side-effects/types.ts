/**
 * Types for the side-effect dispatcher.
 *
 * Every outbound effect the app performs (email, calendar write, MCP callback,
 * future SMS/payment/webhooks) MUST flow through `dispatch()` in dispatcher.ts.
 * See RISK-MANAGEMENT.md for the full methodology.
 */

/**
 * Discriminated union of every outbound effect the app can perform.
 *
 * To add a new kind:
 *   1. Add a branch to this union
 *   2. Add a handler in `handlers/<kind>.ts` that implements live/log/dryrun
 *   3. Register it in `dispatcher.ts` HANDLERS map
 *   4. Add `EFFECT_MODE_<KIND>` env vars per Vercel environment
 *   5. Document in handlers/README.md
 */
export type SideEffect =
  | EmailSendEffect;
  // Future kinds land here:
  // | CalendarCreateEventEffect  (Phase 2)
  // | McpCallbackEffect          (Phase 3)
  // | SmsSendEffect
  // | PaymentChargeEffect
  // | EmailBulkEffect

export interface EmailSendEffect {
  kind: "email.send";
  /** Recipient(s). Single string or array. */
  to: string | string[];
  /** Subject line. */
  subject: string;
  /** Rendered HTML body. */
  html: string;
  /** Optional override of the From address. Defaults to `AgentEnvoy <noreply@agentenvoy.ai>`. */
  from?: string;
  /** Optional Reply-To. */
  replyTo?: string;
  /**
   * Optional context — session, user, anything that helps audit later.
   * Stored on SideEffectLog.contextJson for troubleshooting.
   */
  context?: Record<string, unknown>;
}

/** A dispatched effect's kind, pulled from the union's discriminant. */
export type EffectKind = SideEffect["kind"];

/**
 * Operating modes for a handler. Per-kind env vars (`EFFECT_MODE_EMAIL`, etc.)
 * select which mode is active in a given environment.
 *
 * - `live`       — execute the real side effect
 * - `allowlist`  — execute only if target matches `EFFECT_ALLOW_*`; else fall through to `log`
 * - `log`        — never contact the external service; record payload in SideEffectLog with status=suppressed
 * - `dryrun`     — same as log, but synthesize a plausible fake response so upstream flows continue
 * - `off`        — no-op; write nothing, execute nothing (incident-response kill switch)
 */
export type EffectMode = "live" | "allowlist" | "log" | "dryrun" | "off";

/** Status persisted on SideEffectLog. */
export type EffectStatus = "sent" | "suppressed" | "dryrun" | "failed" | "skipped";

/** Base result shape — every handler return extends this. */
export interface SideEffectResultBase {
  /** Terminal status for audit. */
  status: EffectStatus;
  /** Mode the dispatcher used. Useful for callers that want to adapt UX. */
  mode: EffectMode;
  /** SideEffectLog.id — link into the dashboard. */
  logId: string;
  /** Free-text error if status === "failed"; undefined otherwise. */
  error?: string;
}

/**
 * Per-kind result. Callers index by kind to get typed data.
 *   const result = await dispatch({ kind: "email.send", ... });
 *   if (result.status === "sent") console.log(result.providerMessageId);
 */
export interface EmailSendResult extends SideEffectResultBase {
  kind: "email.send";
  /** Provider-assigned message ID if sent via `live`. Absent otherwise. */
  providerMessageId?: string;
}

export type SideEffectResult<K extends EffectKind = EffectKind> = Extract<
  EmailSendResult, // future: | CalendarCreateEventResult | McpCallbackResult | ...
  { kind: K }
>;
