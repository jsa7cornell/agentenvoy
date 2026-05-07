# Runtime prompts (Category A)

> **This folder is Category A — runtime prompts loaded into LLMs as part of system prompts.** Edits here change product behavior. Review accordingly.

## What this folder is

Every `.md` file here is loaded at runtime by `composeSystemPrompt()` (or via the file-tracing-safe `loadPlaybook(path)` helper, see [SPEC.md](../../../../SPEC.md) §6.4) and concatenated into the prompt sent to Claude. They are **product surface**, not documentation.

Subfolders:
- `fragments/` — shared prompt fragments (voice, ground-truth)
- `classifiers/` — intent classifier playbooks (host-classifier)
- `composers/` — per-intent composer playbooks (calendar-event, calendar-rule, profile, inquire, dealroom-host, dealroom-guest)

## Category A vs Category B — why the distinction matters

Two categories of documentation in this project:

| | Category A — Runtime prompts | Category B — Corpus docs |
|---|---|---|
| **Purpose** | Loaded by LLMs at runtime | Read by humans + agents to understand the system |
| **Lives at** | `app/src/agent/runtime-prompts/` (this folder) | `agentenvoy/<NAME>.md` (COMPOSER, AVAILABILITY, GREETINGS, etc.) |
| **Edit changes...** | Product behavior — model output shifts | Engineer mental model |
| **Review bar** | High — every word counts; behavior diff is observable | Standard doc review |
| **Examples** | `voice.md`, `calendar-event-composer.md` | `COMPOSER.md`, `AVAILABILITY.md` |
| **Naming** | Inside this folder; lowercase-dash slugs | Project root; UPPERCASE-DASH names |

**Don't confuse the two.** A corpus doc named `COMPOSER.md` (project root) describes the composer architecture and failure-mode catalogue for engineers; the runtime prompt `composers/calendar-event-composer.md` (this folder) is the literal text Claude sees during composition. The corpus doc CAN diverge from the runtime prompt — they serve different audiences, and the engineer-facing version may be tuned for clarity over LLM-reliability.

## Editing rules

1. **File paths in `readFileSync` calls MUST be string literals** — Vercel's `@vercel/nft` traces files via static AST analysis. The `loadPlaybook(relPath)` wrapper must inline literal paths in every named export. **Don't introduce dynamic path construction**; the 2026-04-28 prod outage (`498277b` hotfix) was caused by exactly this.

2. **PLAYBOOK Rule 17(c) requires `composeSystemPrompt()` as the single composition point.** All system prompts assemble through that helper or via `loadPlaybook(literalPath)`. Inline `readFileSync` of playbook files outside those helpers is prohibited and CI grep-blocked.

3. **PLAYBOOK Rule 17(b): no new top-level playbook files without a proposal.** The folder structure (`fragments/`, `classifiers/`, `composers/`) is canonical. New composer = new proposal explaining why an existing composer can't absorb it.

4. **Every change here ships with a corpus update** ([COMPOSER.md](../../../../COMPOSER.md) §3 decision history) per PLAYBOOK Rule 16 (corpus discipline).

## Folder rename — landed 2026-05-04

Folder renamed from `playbooks/` to `runtime-prompts/` on 2026-05-04 to disambiguate from `agentenvoy/PLAYBOOK.md` (Category B corpus doc — same word, different concept). The rename touched all literal-path call sites in `index.ts`, integration tests, eval rubric, and `next.config.mjs` `outputFileTracingIncludes`; brain doc references in COMPOSER/AVAILABILITY/SPEC/PLAYBOOK were updated separately. Pre-existing internal doc `composers/MERGE-AUDIT.md` retains its historical path references (describing the 2026-04-28 PR2 merge from old `calendar.md`/`negotiation.md` filenames) — those are historical record, not current paths.
