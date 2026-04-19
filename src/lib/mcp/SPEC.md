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
