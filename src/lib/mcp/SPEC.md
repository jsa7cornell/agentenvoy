# MCP implementation SPEC — correctness details

> **Source of truth for the MCP surface's correctness-critical details.**
> Supplements the parent [2026-04-18 · MCP two-Envoy handshake](../../../../proposals/2026-04-18_mcp-two-envoy-handshake_reviewed-2026-04-18.md) proposal.
> Decided 2026-04-19 via [2026-04-18_mcp-spec-draft_reviewed-2026-04-19_decided-2026-04-19.md](../../../../proposals/2026-04-18_mcp-spec-draft_reviewed-2026-04-19_decided-2026-04-19.md).
> With the 2026-04-20 addendum folding in `91fa4e8` (`no_in_person` rule, `host_update` metadata kind, `activity`/`activityIcon` on `link.parameters`).

This file is intentionally short — it's a pointer to the decision record plus the invariants that the code in this module enforces. Future edits happen here via normal code review.

## Why this surface exists (pointer)

The MCP surface is how non-Envoy **delegates** — Claude, a guest's EA, a future third-party agent — participate in AgentEnvoy coordination on equal footing with Envoy. Today's surface is **guest-side only** (`/api/mcp`, public, scoped to a meeting link); a **host-side** surface where a principal's own LLM acts as them (OAuth-authenticated, scoped by consent) is on the roadmap — see `WISHLIST.md` item 39, and item 41 for the downstream Anthropic Connector Directory goal. The "why" for all of this lives in `AGENTENVOY-VISION.md` §1, §7 (terminology: Principal, Delegate, Envoy, External agent, MCP surface), and §10. Invariants and contracts below are the *how*; the vision doc owns the *why* and the vocabulary.

## Agent platform — status & roadmap

High-level map of what's built vs. what's still owed. "Agent platform" = the whole stack that lets a non-Envoy delegate participate: the MCP wire, the auth model, the consent and rate-limit machinery, the role system, the connector flows. Individual invariants and test contracts live below in *Invariants* and *Test matrix*; this section is the product-surface ledger.

### Shipped (live today — guest-side)

| Capability | Where | Notes |
|---|---|---|
| Guest-side MCP server | `/api/mcp` (Next.js route) | Public, meeting-link-scoped. No account required for callers. |
| Bare-slug resolution | `User.meetSlug` → `ensureDefaultLinkForUser` | A `meetingUrl` of `/johnanderson` resolves to the primary link; no `/code` fragment required for the primary. |
| Tool: `get_meeting_parameters` | `tools.ts#handleGetMeetingParameters` | Returns `ParameterEnvelope`s for format/location/duration/topic/start, plus `rules` passthrough (isVip, timingPreference.anchor, guestPicksWindow). |
| Tool: `get_availability` | `tools.ts#handleGetAvailability` | Scored slot set with preference signals (`slot.preferred` when `score ≤ -1`). Integer-band documented in §8. |
| Tool: `propose_parameters` | `tools.ts#handleProposeParameters` | Guest-agent-initiated parameter proposals; validates against `allowedValues`, never `preferred`. |
| Tool: `propose_lock` | `tools.ts#handleProposeLock` | Atomic CAS on session status; refuses on non-accepted consent. |
| Tool: `get_session_status` | `tools.ts#handleGetSessionStatus` | Polling endpoint; closed status union. |
| Tool: `post_message` | `tools.ts#handlePostMessage` | External agent posts a chat turn into the event view. |
| Tool: `cancel_meeting` | `tools.ts#handleCancelMeeting` | Delegate-initiated cancel. **Shipped 2026-04-29 (PR #192)** — wires through `cancel-pipeline.ts`. |
| Tool: `reschedule_meeting` | `tools.ts#handleRescheduleMeeting` → `reschedule-pipeline.ts#rescheduleSession` | **Live — patch-in-place via Google Calendar `events.patch`.** Preserves iCalUID (single update notification, calendars update in place). Idempotent on `(sessionId, idempotencyKey)` via `RescheduleAttempt`. Wire `status: "rescheduled"` is operation-success literal — DB column `NegotiationSession.status` stays `"agreed"` after the rebook. **Asymmetry vs. cancel-pipeline**: GCal patch failure ABORTS (returns `gcal_patch_failed`, no DB update). Rationale: missed-cancel leaves a recoverable ghost event; missed-reschedule sends people to the wrong time. **Shipped 2026-04-30** (proposal `2026-04-29_mcp-reschedule-meeting-patch-in-place_*_decided-2026-04-30.md`). |
| Tool: `lock_activity_location` | `tools.ts#handleLockActivityLocation` | Guest-agent parity for the host-Envoy dialog action of the same name (per `proposals/2026-04-22_guest-activity-location-negotiation_reviewed-2026-04-22.md`). Server-side handler is shared (`@/agent/actions#handleLockActivityLocation`) so host- and guest-driven negotiation can never drift. **Shipped 2026-04-29.** |
| `external_agent` role | `Message.role`, `identity-prefix.ts` | First-class role in the session model; prefixed at LLM history boundary (invariant 5). |
| Consent-request flow | `consent-request.ts`, `ConsentRequest` model | Host approves/denies external-agent parameter proposals before lock (invariant 2). |
| Rate limiting | `rate-limit.ts`, `MCPRateCounter` | UPSERT counter, atomic under READ COMMITTED (invariant 1). Per-link window. |
| Rationale safety | `rationale.ts`, `placeholders.ts` | Prompt-constrained + post-generation validator + template fallback; prose redacted from call log (invariant 3). |
| Email hashing | `email-hash.ts` | Per-link salted hash; cross-link correlation impossible (invariant 4). |
| Call log redaction | `call-log.ts` | Schema-driven; every field has a named redaction class (invariant 7). |
| `canObject` derivation | `can-object.ts` | Pure function over session state (invariant 6). |
| Preference signal surface | `tools.ts` + `scoring.ts` | Envelope `.preferred` primitive + `slot.preferred` + `rules.isVip`/`timingPreference`/`guestPicksWindow` passthrough (invariant 8, 9). Shipped PR sweep 2026-04-20. |

### Shipped (live today — host-side)

| Capability | Where | Notes |
|---|---|---|
| Host-side MCP server | `/api/mcp/host` (Next.js route) | PAT-bearer auth; principal is the host's user account. Per-PAT rate-limit bucket (`host_pat:<tokenId>`). **Shipped 2026-04-30** (parent: `proposals/2026-04-29_host-side-mcp-act-as-me_*_decided-2026-04-29.md`; stabilization fold: `proposals/2026-04-30_host-mcp-stabilization-package_*_decided-2026-04-30.md`). |
| PAT mint / list / revoke | `/api/host/tokens` (POST mint, GET list), `/api/host/tokens/:id` (DELETE revoke) | Format: `agentenvoy_pat_live_<43-char-base62>`. Plaintext shown ONCE at mint; SHA-256 stored. `displayId` (8 chars) for revocation UI. **`_live_` prefix is reserved**: when a `_test_` tier lands, it shares the same hash table and rate-limit bucket-space prefix; no plaintext crosses tiers; mint endpoint validates the prefix. |
| Scope cascade | `auth.ts#hasScope` | `admin ⊇ schedule ⊇ read`. Coarse-grained by deliberate decision per parent §6 — fine-grained scopes deferred until a real use case requires them. |
| Per-tool scope enforcement | `host-tools.ts#wrapWithScopeCheck` | Scope is checked PER-CALL (typed `scope_denied` refusal), not per-request union. The earlier transport-boundary union check was a bug — read-only PATs were structurally non-functional because they'd fail the union of every registered tool's `requiredScope`. Stabilization-package §B5. |
| Tool: `create_link` | `host-tools.ts#handleCreateLinkTool` → `agent/actions.ts#handleCreateLink` | Mints a shareable URL the host distributes manually. **No email parameters** — AgentEnvoy is URL-based, not email-reliant. Activity-vocab seeds duration when omitted (e.g., `activity: "coffee"` → 30 min, `"hike"` → 120 min; see `src/lib/activity-vocab.ts`). |
| Host call logging | `host-tools.ts#withHostCallLogging` → `call-log.ts#writeMcpCallLog` | Each host call writes `MCPCallLog` with `userId` set, `linkId` null, `principal: { kind: "host_pat", tokenId, displayId }`. Discriminator on `principal.kind` per parent §7.4 Option A — no parallel column. |
| **Scope IS consent** | (architectural) | No per-call consent gate. No `consent_required` refusal. The host granting a `schedule`-scoped token IS the authorization for write tools. Decided in parent §6, reaffirmed in stabilization-package. |
| Rate limiting (host bucket) | `auth.ts#checkHostPatRateLimit` | Single bucket per PAT (60 calls / 60 sec, fail-closed). Distinct from per-link guest buckets. |
| Manifest discovery | `/.well-known/mcp.json` | Advertises both `/api/mcp` (guest URL-capability) and `/api/mcp/host` (host PAT-bearer). `urlPattern` accepts both `/meet/{slug}/{code}` (canonical) and `/meet/{slug}?c={code}` (legacy). `MANIFEST_HIDDEN_TOOLS` is empty after 2026-04-30 (was previously hiding `reschedule_meeting` while it returned `tool_not_implemented`; now live and visible). |

### CI lints (structural protections)

These tests run on every PR and fail loudly when registry shapes drift:

| Lint | Where | What it catches |
|---|---|---|
| Every `MCP_TOOLS` entry has `MCP_RATE_LIMITS` | `__tests__/unit/mcp-schemas.test.ts` | A tool registered without a rate-limit policy falls into the unknown-tool fail-closed branch (which is what bit `lock_activity_location` — every call returned a fixed `retryAfterSeconds: 30` regardless of caller IP or timing). |
| Every `HOST_MCP_TOOLS` entry has `requiredScope` ∈ {read,schedule,admin} | `__tests__/unit/mcp-schemas.test.ts` | A host tool registered without a scope would inherit no enforcement. |

### Owed (roadmap)

| Gap | Blocker / owner | Tracked |
|---|---|---|
| **Additional host tools — read-tier (`get_my_availability`, `list_my_sessions`).** PR-2 of parent host-MCP proposal. Sequenced after stabilization-package lands. | Stabilization shipped 2026-04-30 — PR-2 next | parent host-MCP proposal §11 |
| **Additional host tools — write-tier (`post_to_deal_room`, `confirm_session`).** PR-3b of parent. Includes deal-room `host_agent` banner. | Stabilization shipped 2026-04-30 — after PR-2 | parent host-MCP proposal §11 |
| **Host-side `reschedule_my_session`.** Wishlist #46. Reuses `rescheduleSession()` from the just-shipped pipeline; needs a thin host-tools handler that derives `hostId` from PAT principal context. | Pipeline shipped 2026-04-30 — host handler is the remaining work | parent host-MCP §11 |
| **OAuth 2.1 + PKCE infrastructure.** PAT bridge is sufficient for John and friends-with-Claude per the friend-fit framing; OAuth deferred indefinitely until there's a real reason (Connector Directory submission, friend asks for it). | Indefinitely deferred | parent §11 |
| **`propose_lock` offer-set enforcement.** Server currently does not validate that a proposed `start` is a member of the last `get_availability` slot set. Guest agents have a client-side contract not to synthesize out-of-set times, but nothing enforces it server-side. Follow-up: reuse or fork `slot_mismatch` into offer-set membership vs. session-level contention. | Carried as wishlist | §8 bullet "Class 4"; issue follow-up |
| **Script F' enablement.** External-agent "suggest a time outside the offered set" path. Two gaps that must ship together: (a) MCP wire — either new `propose_slot` tool or extend `propose_parameters` to carry a datetime override; (b) widget `deriveMode` — auto-transition from `offer` → `negotiate` with one-line narration when the external agent's suggestion lands. | ~1 day of work once proposal lands | `WISHLIST.md` #40 |
| **Directives → `linkRules` persistence + MCP passthrough.** Directives extracted from Envoy↔host clarification turns don't persist into `linkRules` yet. When they do, the preference signal surface extends to include them — same pattern as `timingLabel`. | Decoupled; lands on its own clock | Noted in §8 "Envoy↔host clarifications (out of scope here)" |
| **Connector Directory submission.** Submit AgentEnvoy to Anthropic's curated connector directory once host-side MCP is production-ready. This is distribution infrastructure, not a code change. Prerequisites: OAuth, audit log, developer docs, one clean quarter of deploys. | Blocked on WISHLIST #39 shipping | `WISHLIST.md` #41 |
| **MCP-side consent-retraction UX.** `retract_consent` tool exists on the wire; what happens in-session when the host retracts after a slot is locked is still a TBD design question. Under current invariant 2, retraction blocks *future* `propose_lock` but doesn't rewind past commitments. Acceptable v1; document-the-gap when it bites. | Light follow-up | This section |
| **Developer docs.** `/docs/mcp` public surface for third-party delegate authors. Does not exist. Blocks Connector Directory submission and organic third-party delegate adoption. | Dependent on host-side MCP stabilizing | `WISHLIST.md` #41 prerequisite |

### Invariants that still need wired-up tests

From the test matrix below, a handful of invariants are documented but don't have dedicated tests beyond the unit harness:

- **Preference signal surface parity** (invariant 8) — guarded by `derive-timing-anchor.test.ts` for the `timingLabel → anchor` projection, but no integration test exercises the full `scoring.ts → tools.ts → wire` chain. Additive when the host-side MCP lands and we need to assert both sides stay in sync.
- **`propose_lock` offer-set enforcement** — no test, because no server-side check. Ships with the server-side check (see roadmap row).
- **Envelope `.preferred` advisory-only semantics** (invariant 9) — unit-tested at parse time; no integration test asserting `propose_lock` with `overrides.format = preferred` ≠ `overrides.format ∈ allowedValues`. Low priority; Zod schema catches the structural case.

Keep this section current: when a roadmap row ships, move it up to *Shipped* and update the invariants list if it added one.

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

   - **Score is integer-valued by construction; emitted via shared derivation.** Every writer in `src/lib/scoring.ts` emits an integer literal (`-2, -1, 0, 1, 2, 3, 4, 5`). The wire documents the bands: `≤ -1` host-preferred (★), `0–1` bookable (`first_offer` tier), `2–3` VIP backup (`stretch1`/`stretch2`, only emitted when `rules.isVip` is true), `≥ 4` blocked (never emitted). The `(-1, 0)` band is empty by construction — a future reader seeing a continuous score there should treat it as a scoring-layer bug, not a new band. **The wire-emit integer is derived per-call by `deriveEmittedScore` in `src/lib/scoring-emit.ts`** — the host-stable `slot.score` from `scoreSlot` is never mutated by per-link rules. Pre-2026-05-01 the score was mutated in-place by `applyEventOverrides`; the new pattern keeps `score` host-stable and derives the wire integer from `(baseScore, rules.availability.*, rules.preferred.*)` at the wire-emit step. Score-band filters (in `tools.ts`/`agent-snapshot.ts`/`negotiate/slots`) read the host-stable score; only the wire emission reads the derived integer.
   - **`slot.preferred: boolean` is derived from membership, not from the score.** Emitted when the slot is in `rules.availability.restrictToSlots` (host-pinned exclusive) OR in `rules.preferred.{days, windows, slots}` (host explicit preference). The shared derivation function is `deriveEmittedPreferred` in `scoring-emit.ts`. Both MCP wire surfaces (`get_availability`, `get_my_availability`) and the single-fetch agent surface (`agent-snapshot.ts` → `/agent.json`) call this same helper — they cannot drift on what `preferred` means. Web-greeting parity (`greeting-template.ts#isPreferred`) is currently a separate inline derivation; consolidating it through the same helper is a tracked follow-up to this rewrite (greeting-template needs `rules`/`tz` plumbed through prose helpers; flagged as out-of-scope from the 2026-05-01 MCP wire-up). Per-call derivation means a slot's `preferred` flag is per-link, not per-host — same slot may emit `preferred: true` on a contextual link with `preferred.days: ["Wed"]` and `preferred: false` on a generic link.
   - **`rules.timingPreference.anchor`** is derived from `rules.timingLabel` via the shared helper `deriveTimingAnchor` in `src/lib/scoring.ts` — the single source of truth for both the web greeting's prose opener (`src/app/api/negotiate/session/route.ts`, `proseAnchor`) and the MCP rule projection. Guest agents branch on `anchor`; `timingLabel` is kept alongside for free-form nuance.
   - **`rules.isVip: boolean`** echo is intentional, not a leak. Server-side it gates tier visibility; client-side it lets guest agents explain their output ("your host prioritized these times because you're a VIP"). Document-intent here rather than leaving future-you wondering whether it leaked accidentally.
   - **`rules.guestPicksWindow`** echoes the host's hour-of-day clamp so guest agents can explain "why am I only seeing slots after 9am." Server-applied; echo is context for narration.
   - **Class 4 (out-of-window provisional acceptance) is wishlist.** No MCP tool exists; guest agents MUST NOT synthesize `propose_lock` for times outside the `get_availability` slot set. **Server enforcement is currently not implemented** — `confirm-pipeline` reuses `slot_mismatch` for session-level contention, not offer-set membership. Tracked as follow-up ("propose_lock offer-set enforcement"); until it lands, this is a client-behavior contract, not a server guarantee.
   - **Envoy↔host clarifications (out of scope here).** Directives extracted from host clarification turns are not yet persisted into `linkRules`. When they are, this invariant extends to document their MCP passthrough — same pattern as `timingLabel`.

   See proposals `2026-04-20_mcp-preference-signal-surface_reviewed-2026-04-20.md` (original primitive) and `2026-05-01_event-availability-vs-preferred-vs-calendar-scoring_reviewed-2026-05-01_decided-2026-05-01.md` (three-band restructure + `scoring-emit.ts` shared derivation). Parity test (`derive-timing-anchor.test.ts`) is the Rule-16 equivalent guarding web-greeting ↔ MCP sync.

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
