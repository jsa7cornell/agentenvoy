<!--
⚠️ HISTORICAL — describes a 2026-04-27 PR3 merge. The whole Composer architecture
is retired as of 2026-05-11. Keep for institutional memory; do not act on it.
See `./README.md` and `agentenvoy/UNIFIEDAGENT.md`.
-->

# Deal-room composer merge audit (PR3)

Date: 2026-04-27
Author: Claude (PR3 implementation pass)

Source files merged in this PR:
- `src/agent/playbooks/composers/dealroom-guest-composer.md` (547 lines, base — was renamed from `calendar.md` in PR2)
- `src/agent/playbooks/negotiation.md` (81 lines) → merged into `dealroom-guest-composer.md` as the new "## Negotiation Strategy" section
- The "Host Messages in the Deal Room" section that lived inside the guest composer (13 lines, part of the original `calendar.md`) → extracted, expanded, and lifted into the new `dealroom-host-composer.md`

Final state:
- `dealroom-guest-composer.md` — 621 lines (no guidance dropped; some new structure added with `## Negotiation Strategy` heading)
- `dealroom-host-composer.md` — 134 lines (NEW)
- `negotiation.md` — DELETED in this PR
- `src/lib/proposal-synthesizer/playbooks/administrator.md` — **NOT** deleted (see "Spec deviation" below)

## Spec deviation: `src/lib/proposal-synthesizer/playbooks/administrator.md` retained

The PR3 brief calls for `src/lib/proposal-synthesizer/playbooks/administrator.md` to be merged into the deal-room composers and then deleted. **I did not delete it, and no content from that file landed in either composer.** Reason: the proposal's PR3 plan rests on a misidentification. That file is the system prompt for an entirely different feature — the multi-agent proposal synthesizer at `/api/negotiator/synthesize/route.ts`, which compares competing AI-agent research outputs and emits a JSON synthesis (see `src/lib/proposal-synthesizer/administrator.ts:composeAdministratorPrompt`). It has nothing to do with deal-room negotiation. Its 85 lines are entirely about JSON output schemas, agent labeling rules, and "common ground vs. key differences" synthesis — none of which is meaningful to a guest or host in a calendar deal room.

The deal-room flow uses `src/agent/administrator.ts` (a same-named but different file) which calls `composeSystemPrompt` in `src/agent/composer.ts`, which in turn loads `dealroomGuestComposer()` and `negotiationPlaybook()`. The "host-relevant content from administrator.md" the proposal refers to is actually the "Host Messages in the Deal Room" section that lived inside `dealroom-guest-composer.md` (former `calendar.md`) all along.

I extracted the host-relevant guidance from there, expanded it into a focused composer, and left `src/lib/proposal-synthesizer/playbooks/administrator.md` and its `administratorPlaybook()` export intact. Deleting it would have broken `/api/negotiator/synthesize` with no compensating benefit. Flagging this here so the reviewer can confirm or override.

If the reviewer (or John) intends for the proposal-synthesizer file to also be renamed/relocated as part of the playbooks/ cleanup, that's a separate, mechanical PR — it doesn't belong inside the deal-room composer split.

## Section mapping

### `dealroom-guest-composer.md` (post-merge)

The base file was the existing 547-line `dealroom-guest-composer.md` (calendar.md content). Section ordering preserved end-to-end except where noted.

| Section | Source | Notes |
|---|---|---|
| Calendar Coordination intro | base | unchanged |
| OFFERABLE SLOTS Rule (MANDATORY) | base | unchanged |
| Calendar Reasoning — Slot Tiers | base | unchanged |
| Protection Score Reference | base | unchanged |
| Greeting Strategy | base | unchanged |
| Context Sharing | base | unchanged |
| Proposals — Broad, Honest, Contextualized | base | unchanged |
| Timezone Rule (MANDATORY) | base | unchanged |
| Availability Depth — AI Judgment | base | unchanged |
| Location Reasoning | base | one minor edit: changed "(\`[HOST]:\` messages present)" → "(their composer turns appear in history)" since the prefix-sniffing pattern is no longer the audience signal. Same semantic intent. |
| Relative-Time Phrases | base | unchanged |
| Time Intelligence | base | unchanged |
| Activity + Location Negotiation | base | unchanged |
| **Host Messages in the Deal Room** | **REMOVED** | Replaced with a one-line HTML comment. Audience is now fixed by routing — guest composer no longer interprets `[HOST]:` prefixes. The lifted-and-expanded content lives in `dealroom-host-composer.md`. |
| Format Rules | base | unchanged |
| **Negotiation Strategy** (NEW header) | merged from `negotiation.md` | See sub-table below. |
| Proxy Scheduling | base | unchanged |
| Handling Responses | base | unchanged |
| Day-of-Week Rule | base | unchanged |
| Confirmation Proposal Format | base | unchanged |
| Status Updates | base | unchanged |
| Feedback Seeking | base | unchanged |
| Common Patterns | base | unchanged |
| Actions | base | unchanged |
| Group Event Coordination | base | unchanged |
| Updating a confirmed meeting | base | unchanged |

### Negotiation Strategy sub-mapping (from `negotiation.md`)

`negotiation.md` was 81 lines, 8 sections. All 8 sections are preserved verbatim under the new "## Negotiation Strategy" h2 header in the guest composer, except for one de-duplication (noted below).

| `negotiation.md` section | Destination in guest composer | Notes |
|---|---|---|
| Progressive Disclosure (3 Tiers) | Negotiation Strategy → Progressive Disclosure (3 Tiers) | preserved verbatim. Added a parenthetical noting the relationship to the existing "Availability Depth" section above ("two levels, not three" vs. "three tiers" — these are not contradictory, they describe different decisions: depth-of-options vs. order-of-escalation). |
| Smart Defaults | Negotiation Strategy → Smart Defaults | preserved verbatim |
| Anchoring | Negotiation Strategy → Anchoring | preserved verbatim |
| Graceful Narrowing | Negotiation Strategy → Graceful Narrowing | preserved verbatim |
| Counter-Proposal Handling | **DROPPED** as separate subsection | The base `dealroom-guest-composer.md` already has a "Handling Responses → Guest counter-proposes" subsection that says the same things in slightly more concrete language. Adding a second copy of the same guidance under a slightly different name created a contradiction risk if either was edited later. Marked the drop with an HTML comment in the merged file. **No semantic loss.** |
| Information Asymmetry | Negotiation Strategy → Information Asymmetry | preserved verbatim |
| Confirmation Discipline | Negotiation Strategy → Confirmation Discipline | preserved verbatim |
| Escalation Protocol | Negotiation Strategy → Escalation Protocol | preserved verbatim |

### `dealroom-host-composer.md` (NEW)

Sourced from:
- The "Host Messages in the Deal Room" section that lived inside the former `calendar.md` (lines 313–325 pre-edit). That 13-line block contained the seed of host-as-principal direction: directives ("book it", "offer next week", "skip Wednesday", "cancel"), authority framing ("Host is the authority"), and the dual-audience reminder ("respond by speaking to the guest").
- Expanded to ~134 lines with:
  - Audience model rationale (no more prefix-sniffing — role is fixed by routing)
  - Tone-with-host (terse, direct, but guest-readable register)
  - Status-question handling (read the question, answer it, no action emission)
  - `gcal_update_proposal` flow lifted from the existing "Updating a confirmed meeting" section in the guest composer (host-side framing only — guests don't initiate update proposals)
  - Action grammar with the host-applicable subset (`cancel`, `update_format`, `update_time`, `update_location`, `update_meeting_settings`)
  - Confirmation Proposal + Status Update block formats
  - Day-of-Week + Timezone rules (same MANDATORY rules apply on the host side; copied because each composer is meant to stand alone)
  - Explicit non-goals: no progressive disclosure on the host, no re-greeting, no negotiation-back, no over-narration

## Dropped content

- `negotiation.md` "Counter-Proposal Handling" subsection (5 lines) — already covered verbatim-equivalent in the guest composer's "Handling Responses → Guest counter-proposes" block. No semantic loss.
- The `[HOST]:` prefix-sniffing language and the "If a message does NOT have the `[HOST]:` prefix, it's from the guest" line — replaced by routing-driven audience selection. Both composers now know their audience by file.

Nothing else was dropped. All other negotiation.md content is preserved either verbatim under the new "Negotiation Strategy" h2 or under an equivalent existing heading in the guest composer.

## Risk notes

1. **Progressive Disclosure (3 Tiers) vs. Availability Depth (2 levels).** The guest composer now contains both. They are not contradictory but the relationship isn't obvious on first read. I added a parenthetical clarifier ("That section is about how much availability to show; this one is about the *order* of escalation when the guest doesn't bite on the first round."). If post-merge prod testing surfaces Sonnet getting confused between them, the right fix is to fold one into the other — but doing that mechanically inside this PR risked dropping guidance, so I preferred preserving both with the disambiguation note.

2. **Host composer not directly tested against historical host-utterance regressions.** The integration test added in this PR covers three scenarios (directive emits action, status-question does NOT emit action, guest message routes to guest composer). It does not cover the long tail of host phrasings that worked under the prefix-sniffing model. If the bench/prod testing surfaces host-side regressions, the trace points are: (a) is `isHost` arriving at the composer? (b) is the host composer being loaded? (c) does the composer's host-tone guidance need stronger framing for the failing utterance class?

3. **The `administrator.md` retention** described in "Spec deviation" above is the highest single risk on this PR for a reviewer who reads the proposal first and the code second. I am explicit about it here so it's not a surprise.

4. **No PR1/PR2 behavior change cross-validated.** PR3 changes the deal-room system prompt assembly. The pre-PR3 path went `composer.ts → groundTruth + voice + negotiation + dealroomGuestComposer`. The post-PR3 path goes `composer.ts → groundTruth + voice + (dealroomHostComposer OR dealroomGuestComposer)` (negotiation.md content is now inside the guest composer). For the guest path, the composed prompt is byte-near-equivalent (negotiation.md content is now a section in the guest composer file rather than a separate concatenation). The order of negotiation guidance vs. calendar guidance has changed: pre-PR3, negotiation came BEFORE calendar; post-PR3, negotiation is a section AFTER the calendar reasoning core. If the model was relying on negotiation framing setting the tone before calendar specifics, this is a subtle change. Bench/integration tests should catch any regression.
