# Side-effect handlers

One handler per `SideEffect["kind"]`. Each handler owns the
`live` / `allowlist` / `log` / `dryrun` / `off` behavior for one kind of
outbound action. The dispatcher in `../dispatcher.ts` decides which mode to
use based on `EFFECT_MODE_<KIND>` env vars.

## Adding a new kind

1. **Define the effect shape in `../types.ts`**
   - Add a new branch to the `SideEffect` discriminated union
   - Add a matching `XResult` interface extending `SideEffectResultBase`
   - Extend the `SideEffectResult<K>` mapped type so callers get typed results

2. **Write a handler in this directory**
   - One file per kind: `email.ts`, `calendar.ts`, `mcp_callback.ts`, etc.
   - Export a `handle<X>(effect, mode)` function returning the handler-outcome shape
     (status, effectiveMode, providerMessageId, error). Keep it async but total — never throw
     for provider-level errors; return `{ status: "failed", error }`. The dispatcher
     wraps in a try/catch for truly unexpected exceptions.
   - Export `summarize<X>Target(effect)` returning a short human string for
     SideEffectLog.targetSummary.

3. **Register it in the dispatcher**
   - Add an entry to `MODE_ENV_VAR` and `DEFAULT_MODE`
   - Add a `case` branch to `runHandler`
   - Add a `case` branch to `scrubPayload` and `summarizeTarget`

4. **Set per-environment env vars in Vercel**
   - Production: usually `live`
   - Preview: usually `log` (or `dryrun` if the caller needs a response shape)
   - Local dev: `log` by default in `.env.tpl`
   - Add a row to the "Per-environment defaults" table in `RISK-MANAGEMENT.md`

5. **Write tests**
   - Unit tests at `src/__tests__/unit/side-effects/<kind>.test.ts`
   - Cover each mode's terminal status + error shape
   - Assert that the SideEffectLog row is written with the right fields

## Mode contract (must-haves)

| Mode | Required behavior |
|------|-------------------|
| `live` | Attempt the real side effect. On success: `status: "sent"` + `providerMessageId` if provider returns one. On error: `status: "failed"` + `error`. |
| `allowlist` | If the target matches the allowlist env var, behave like `live`. Otherwise behave like `log` (return `status: "suppressed"`, `effectiveMode: "log"`). |
| `log` | Never contact the external provider. Return `status: "suppressed"`. |
| `dryrun` | Never contact the external provider. Return `status: "dryrun"` plus a synthetic `providerMessageId` (e.g. `dryrun-<uuid>`) so upstream flows that depend on a response shape don't break. |
| `off` | No-op. Return `status: "skipped"`. Used for incident response. |

## What goes in `payload` on the log

Enough to debug later — **never** secrets or full body dumps that could contain tokens in links. Canonical shape for each kind is defined in `scrubPayload()` in the dispatcher, not in the handler.

## Don't

- Don't call the external SDK anywhere except inside a handler. The Phase 4 CI lint rule will flag this.
- Don't throw for provider failures. Return a failed result.
- Don't skip the dispatcher because "it's just a log message" — if it reaches
  outside the app, it goes through `dispatch()`.
