# MCP implementation SPEC — correctness details

> **Source of truth for the MCP surface's correctness-critical details.**
> Supplements the parent [2026-04-18 · MCP two-Envoy handshake](../../../../proposals/2026-04-18_mcp-two-envoy-handshake_reviewed-2026-04-18.md) proposal.
> Decided 2026-04-19 via [2026-04-18_mcp-spec-draft_reviewed-2026-04-19_decided-2026-04-19.md](../../../../proposals/2026-04-18_mcp-spec-draft_reviewed-2026-04-19_decided-2026-04-19.md).
> With the 2026-04-20 addendum folding in `91fa4e8` (`no_in_person` rule, `host_update` metadata kind, `activity`/`activityIcon` on `link.rules`).

This file is intentionally short — it's a pointer to the decision record plus the invariants that the code in this module enforces. Future edits happen here via normal code review.

## Modules in `src/lib/mcp/`

| File | Responsibility | SPEC § |
|---|---|---|
| `placeholders.ts` | `RATIONALE_PLACEHOLDERS` typed const + derived union | §3.1, §9 Q4 |
| `rate-limit.ts` | UPSERT counter pattern, server-side `NOW()`, atomic under READ COMMITTED | §1 |
| `consent-request.ts` | Create / accept / retract `ConsentRequest` rows; `guardConsentForProposeLock` invariant | §2 |
| `rationale.ts` | Prompt constraints, post-generation validator, template render | §3 |
| `email-hash.ts` | Per-link salted hash of guest email; domain-preserving mask | §4 |
| `identity-prefix.ts` | External-agent turn prefix at LLM history assembly boundary | §5 |
| `can-object.ts` | `canObject(session)` derivation over terminal states | §6 |
| `call-log.ts` | Redaction table + `redactForCallLog(tool, field, value)` | §7 |

## Invariants this module enforces

1. **Rate counter atomicity.** N concurrent increments within a fresh window produce `finalCount === N` (exact). Window reset is atomic (50 pre + 50 post → 50 in new window). Under READ COMMITTED, `ON CONFLICT DO UPDATE` holds the row lock and the `CASE` evaluates against the post-lock state.
2. **Propose-lock refuses on non-accepted consent.** Any `ConsentRequest` in `{pending, retracted, expired}` for the target field blocks `propose_lock` with `consent_not_accepted`.
3. **Rationale prose never travels to `MCPCallLog`.** The redaction table drops `rationaleProse` at log-write. A runtime validator blocks URL/email/phone/length-200+ from ever reaching the live UI; on trip, the template-rendered output is shown instead.
4. **Email hashes are per-link.** `sha256(hashSalt || localPart || "@" || domain)` — cross-link correlation is impossible, domain is preserved for debugging.
5. **`external_agent` turns are prefixed at the LLM boundary, not at the DB.** The DB's `Message.content` is the verbatim text; the prefix is applied when assembling the LLM history.
6. **`canObject` is derived, not stored.** A single function over `(session.status, finalizesAt, supersededByRescheduleId, now)`.
7. **Log redaction is schema-driven.** Every field in every tool response has a named redaction class (`verbatim`, `hashed`, `cap(N)`, `drop`, `shape-summary`). The log writer iterates the map; there is no "ad-hoc redaction at the call site."
8. **Preference signal surface — MCP mirrors web greeting framing.** The MCP wire carries the same preference signals the host-side prose greeting reads, so guest agents can produce the same preference-aware framing without re-implementing host logic.

   - **Score is integer-valued by construction.** Every writer in `src/lib/scoring.ts` emits an integer literal (`-2, -1, 0, 1, 2, 3, 4, 5`). The wire documents the bands: `≤ -1` host-preferred (★), `0–1` bookable (`first_offer` tier), `2–3` VIP backup (`stretch1`/`stretch2`, only emitted when `rules.isVip` is true), `≥ 4` blocked (never emitted). The `(-1, 0)` band is empty by construction — a future reader seeing a continuous score there should treat it as a scoring-layer bug, not a new band.
   - **`slot.preferred: boolean`** is emitted when `score ≤ -1`, matching `greeting-template.ts`'s `isPreferred` predicate exactly. The predicates stay aligned by convention; if the threshold is ever tuned, both surfaces move together and the band docs update in lockstep.
   - **`rules.timingPreference.anchor`** is derived from `rules.timingLabel` via the shared helper `deriveTimingAnchor` in `src/lib/scoring.ts` — the single source of truth for both the web greeting's prose opener (`src/app/api/negotiate/session/route.ts`, `proseAnchor`) and the MCP rule projection. Guest agents branch on `anchor`; `timingLabel` is kept alongside for free-form nuance.
   - **`rules.isVip: boolean`** echo is intentional, not a leak. Server-side it gates tier visibility; client-side it lets guest agents explain their output ("your host prioritized these times because you're a VIP"). Document-intent here rather than leaving future-you wondering whether it leaked accidentally.
   - **`rules.guestPicksWindow`** echoes the host's hour-of-day clamp so guest agents can explain "why am I only seeing slots after 9am." Server-applied; echo is context for narration.
   - **Class 4 (out-of-window provisional acceptance) is wishlist.** No MCP tool exists; guest agents MUST NOT synthesize `propose_lock` for times outside the `get_availability` slot set. **Server enforcement is currently not implemented** — `confirm-pipeline` reuses `slot_mismatch` for session-level contention, not offer-set membership. Tracked as follow-up ("propose_lock offer-set enforcement"); until it lands, this is a client-behavior contract, not a server guarantee.
   - **Envoy↔host clarifications (out of scope here).** Directives extracted from host clarification turns are not yet persisted into `linkRules`. When they are, this invariant extends to document their MCP passthrough — same pattern as `timingLabel`.

   See proposal `2026-04-20_mcp-preference-signal-surface_reviewed-2026-04-20.md`. Parity test (`derive-timing-anchor.test.ts`) is the Rule-16 equivalent guarding web-greeting ↔ MCP sync.

9. **`ParameterEnvelope.preferred` is scoped to `delegated` + `preferred ∈ allowedValues`.** The optional `preferred?: T` field on the parameter envelope (handshake §2.3) is host's single preferred value within `allowedValues`. v1 emits it only from `resolveFormat` under `delegated` mutability; `locked`/`host-filled`/`open`/`required` never emit it. The resolver drops `preferred` silently when per-slot `subtractFormatFilters` narrows it out of `allowedValues`; the Zod `envelopeOf` schema enforces `preferred ∈ allowedValues` at parse time as defense-in-depth against hand-constructed bad envelopes. **Advisory-only:** `propose_lock.overrides.format` validates against `allowedValues`, never against `preferred` — `preferred` is display/UI-default only, never implies `value = preferred`. See proposal `2026-04-20_mcp-envelope-preferred-primitive_reviewed-2026-04-20_decided-2026-04-20`.

## Test matrix (from §8 of the decided SPEC)

| File | Harness | Asserts |
|---|---|---|
| `src/__tests__/integration/rate-limit-counter.test.ts` | integration | exact-equality UPSERT race |
| `src/__tests__/integration/consent-request-record.test.ts` | integration | propose_lock invariant |
| `src/__tests__/unit/rationale-redaction.test.ts` | unit | live has prose; log doesn't; placeholders allow-listed; validator catches URL/email/phone |
| `src/__tests__/unit/email-hash.test.ts` | unit | per-link stability, cross-link difference, mask format |
| `src/__tests__/unit/external-agent-history.test.ts` | unit | DB unprefixed; history prefixed; assistantRoles invariant |
| `src/__tests__/unit/can-object.test.ts` | unit | derivation over `(status, finalizesAt, supersededByRescheduleId, now)`. Integration variant lands with the reschedule-pipeline PR that adds the `finalizesAt` / `supersededByRescheduleId` columns to `NegotiationSession`. |
| `src/__tests__/unit/call-log-redaction.test.ts` | unit | per-field redaction class applied |

## See also

- Decision record: [`proposals/2026-04-18_mcp-spec-draft_reviewed-2026-04-19_decided-2026-04-19.md`](../../../../proposals/2026-04-18_mcp-spec-draft_reviewed-2026-04-19_decided-2026-04-19.md) — the full correctness argument, adversarial review, and author responses.
- Harness: [`src/__tests__/integration/README.md`](../../__tests__/integration/README.md).
- 2026-04-20 fold-in: consult `CompiledRules.formatFilters` in the parameter resolver; new `metadata.kind` values follow `host_update`'s branch-before-bubble pattern in `deal-room.tsx`.
