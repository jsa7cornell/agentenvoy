# `app/eval/` — Promptfoo regression catching + Langfuse trace inspection

This directory holds the **Phase 5 eval infrastructure** for AgentEnvoy:
Promptfoo (CI-track regression catching) and Langfuse (dev-track trace
inspection). Per [`archive/refactor-package-2026-04-25/CODEBASE-CLEANUP.md`][cleanup]
item 9, the two tools split:

- **Promptfoo** — primary, runs in CI on every PR that touches the
  classifier prompt, composer prompt, intent enum, or link parameter
  shape. Scores each turn against an LLM-as-judge rubric on four
  dimensions: intent correctness, tone, constraint adherence,
  hallucination. Threshold-based pass/fail catches regressions before
  merge. CI activation lands in a follow-up PR — see "Status" below.
- **Langfuse** — secondary, dev-time only. Self-hosted via
  `docker-compose.langfuse.yml` at the repo root. Used for ad-hoc trace
  inspection during prompt iteration. Production (Vercel) does NOT run
  Langfuse — `LANGFUSE_ENABLED` defaults off, and the SDK is loaded only
  via dynamic import inside `src/lib/langfuse.ts`, so production builds
  have zero footprint from this dependency.

## Two commands

```bash
# Run the Promptfoo eval against the placeholder golden sets.
npm run eval:promptfoo

# Start a local Langfuse instance + Postgres, then enable the SDK in dev.
npm run eval:langfuse:up
LANGFUSE_ENABLED=true npm run dev
# Stop it:
npm run eval:langfuse:down
```

## Layout

```
eval/
├── README.md                       # this file
├── promptfoo.config.yaml           # Promptfoo CLI config
├── judge-rubric.md                 # LLM-as-judge prompt
├── prompts/
│   ├── composer-host.txt           # placeholder — PR 3 wires to real path
│   ├── composer-guest.txt
│   └── intent-classifier.txt
├── golden-sets/
│   ├── host.jsonl                  # placeholder — PR 2 swaps in real curated set
│   ├── guest.jsonl
│   ├── README.md                   # curated-set methodology
│   └── _candidates/
│       ├── README.md               # candidate-extraction lifecycle
│       └── .gitkeep                # *.jsonl files here are gitignored
└── adapt-golden-set.ts             # only emitted if Phase 4 row shape diverges
                                    # from Promptfoo's expected shape
```

For the `_candidates/` lifecycle (Phase 4 PR 2's candidate-extraction
script), see [`golden-sets/_candidates/README.md`](golden-sets/_candidates/README.md).

## Status

This is **Phase 5 PR 1** — eval infrastructure is wired up and runnable
locally, but:

- Golden sets are 5-turn placeholders — John's curated 100-turn frozen
  set lands in **Phase 5 PR 2**.
- Prompt files (`prompts/*.txt`) are 3-line placeholders — the real
  prompt-path wiring lands in **Phase 5 PR 3**.
- Promptfoo CI activation is deferred — the workflow + budgeted
  `ANTHROPIC_API_KEY` secret land in a follow-up once curated golden
  sets are in.
- Langfuse instrumentation hooks are present in `composer.ts` and
  `intent-classifier.ts` (gated behind `LANGFUSE_ENABLED`); they no-op
  in production.

[cleanup]: ../../archive/refactor-package-2026-04-25/CODEBASE-CLEANUP.md
