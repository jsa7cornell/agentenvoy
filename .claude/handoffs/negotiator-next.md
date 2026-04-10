# AgentNegotiator — Continuation Prompt

> Use this to start a new session for further work on the Negotiator feature.

## Session Setup

Read these files in order:
1. `~/AI Brain/PLAYBOOK.md` — global rules
2. `~/AI Brain/agentenvoy/SPEC.md` — full product spec (the **AgentNegotiator** section is the primary reference)
3. `~/AI Brain/agentenvoy/PLAYBOOK.md` — project stack and conventions
4. `~/AI Brain/agentenvoy/app/src/lib/negotiator/types.ts` — all types, model pricing, cost helpers
5. `~/AI Brain/agentenvoy/app/src/lib/negotiator/playbooks/administrator.md` — administrator behavior spec

## What's Built

AgentNegotiator is **shipped and live** at `agentenvoy.ai/negotiate`. Full competing-proposals flow:

- **Config panel** — question + 2-4 agents (any provider/model) + advanced settings (admin model, token budget, max rounds, host private context, document upload)
- **Research phase** — parallel streamed agent proposals with interim labels and live text
- **Synthesis phase** — Administrator compares proposals, outputs structured JSON (common ground, key differences, strengths/risks, route recommendation with confidence score, blend opportunities)
- **Decision phase** — host picks an agent (A) or requests another round (B), guided by admin's recommendation + confidence
- **Finalize phase** — chosen agent refines, others acknowledge, admin writes action items
- **Persistence** — results saved to DB with 6-char share codes, public result pages with OG metadata
- **Usage tracking** — per-step token/cost/duration rows displayed in UI and persisted

## Architecture Quick Reference

```
src/lib/negotiator/          — types, admin prompt, providers, scenarios, extraction
src/components/negotiator/   — all UI components (config, runner, phases, decision, upload)
src/app/negotiate/           — main page + result pages
src/app/api/negotiator/      — research, synthesize, finalize, save, extract routes
```

**State machine** lives in `negotiation-runner.tsx` — phases: idle → researching → synthesizing → awaiting-decision → finalizing → complete.

**Provider abstraction** in `providers.ts` — `getModel(provider, modelId, apiKey?)` routes to direct client or Vercel AI Gateway.

**Administrator prompt** composed in `administrator.ts` — assembles playbook + question + all agent positions + private contexts → single prompt for synthesis.

## Known Issues & Rough Edges

1. **Vercel 60s function timeout** — synthesize route has `maxDuration: 120` but Vercel hobby plan caps at 60s. Complex multi-agent syntheses can 504. May need to switch to streaming or upgrade plan.
2. **No auth on negotiate** — anyone can use it, no login required. Results are public by share code. No rate limiting yet.
3. **Document upload** — extraction works (PDF/DOCX/TXT) but the upload modal and attachment chip were just added. Test edge cases.
4. **Token budget** — budget checking exists but only fires after research phase. A very expensive synthesis could still overshoot.
5. **Mobile responsiveness** — config panel and result pages are desktop-first. Needs responsive pass.
6. **Error recovery** — agent failures show inline errors but there's no retry button. Synthesis parse failures fall back to a stub.

## Likely Next Steps (Not Committed — Use Judgment)

- **RFP document integration** — upload an RFP as shared context, agents respond to specific sections
- **Multi-round improvements** — round 2+ agents see each other's prior proposals and the synthesis; currently they only see host feedback
- **Agent memory/profiles** — save agent configurations for reuse across negotiations
- **Result history** — list of past negotiations on dashboard (currently only accessible by share code)
- **Streaming synthesis** — switch synthesize route from `generateText` to `streamText` to avoid 504 timeouts
- **Cost optimization** — use cheaper models for simple negotiations, expensive for complex
- **Collaborative decisions** — multiple hosts vote on the outcome
- **API access** — programmatic negotiation creation for integration with other tools
- **Testing** — no automated tests exist yet for any negotiator code

## Key Conventions

- All negotiator files use `negotiator/` namespace (not `negotiate/`)
- API routes under `/api/negotiator/` — don't confuse with calendar `/api/negotiate/`
- Types are centralized in `types.ts` — add new types there
- Admin playbook is markdown with embedded JSON schema — keep it self-contained
- CSS uses `var(--neg-*)` custom properties for negotiator-specific theming
- Agent API keys are optional — empty string means use server-side keys
- Share codes are 6 random alphanumeric chars, collision-checked on save
- Usage rows track `{ label, model, tokens, cost, durationMs }` per step
