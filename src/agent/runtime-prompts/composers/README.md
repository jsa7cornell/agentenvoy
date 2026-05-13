# runtime-prompts/composers — LIVE vs RETIRED

> Read before editing anything in this directory.

The directory name `composers/` is a historical artifact. The **Composer architecture is retired** as of the 2026-05-11 unified-agent migration (see [`../../../../../UNIFIEDAGENT.md`](../../../../UNIFIEDAGENT.md) and proposal `2026-05-11_complete-unified-agent-migration-and-retire-classifier-composer_decided-2026-05-11.md`).

Only **two** prompt files in this directory are loaded by the live runtime:

| File | Loaded by | Used for |
|---|---|---|
| `unified-agent.md` | `unifiedAgentSystemPrompt()` → `app/src/agent/unified/runner.ts` | Host channel (every host turn) |
| `dealroom-unified.md` | `dealroomUnifiedSystemPrompt()` → `app/src/agent/unified/dealroom-runner.ts` | Deal-room negotiation (post-Phase-A migration) |

**Every other `.md` file in this directory is retired institutional memory.** They are still loaded by code in `app/src/agent/modules/**` and `app/src/agent/composer.ts`, but the production routes that called those paths are **dead code** as of 2026-05-13 — the deal-room kill-switch flag (`DEALROOM_UNIFIED_ENABLED`) was deleted along with the legacy composer body in `/api/negotiate/message/route.ts`. The composer code stays in the tree pending Phase D's full retirement of `composer.ts` + `modules/**`. Do not author against these files — edits will not change product behavior, and they actively mislead future agents who read corpus docs that still reference them.

## Retired files (do NOT author against)

- `calendar-event-composer.md`
- `calendar-rule-composer.md`
- `dealroom-host-composer.md`
- `dealroom-guest-composer.md`
- `inquire-composer.md`
- `manage-setup-composer.md`
- `profile-composer.md`
- `MERGE-AUDIT.md` (PR3 deal-room merge audit, 2026-04-27)
- `calendar-event/` (subdir — `base.md`, `booking.md`)
- `calendar-rule/` (subdir — `update.md`)
- `chat/` (subdir — `post-calibration.md`)
- `group-coordination/` (subdir — `base.md`)
- `recalibrate/` (subdir — `base.md`, `dormant.md`, `explicit-ask.md`, `first-time.md`)

Each retired top-level file carries a redirect banner at its top pointing to `unified-agent.md`/`dealroom-unified.md`.

## Why the directory still exists

The retired files cannot be deleted yet because zombie consumers in `app/src/agent/modules/**` still import them as fragment path strings (`"composers/<slug>"`). When Phase D of the 2026-05-11 retirement proposal ships, those modules and their prompt fragments delete together. Until then: read the banners.

## Where to edit prompts

- **Host channel prompt** → [`unified-agent.md`](./unified-agent.md)
- **Deal-room prompt (host + guest, role-aware)** → [`dealroom-unified.md`](./dealroom-unified.md)
- **Corpus reference** → [`UNIFIEDAGENT.md`](../../../../UNIFIEDAGENT.md)
