# bench-modules

Per-module bench harness for the composer-modules architecture (per
[`proposals/2026-05-04_composer-modules-architecture_*_decided-2026-05-04.md`](../../../proposals/2026-05-04_composer-modules-architecture_reviewed-2026-05-04_decided-2026-05-04.md)
§4 Test plan + §6 Verification).

Each module ships with bench fixtures that exercise its observable behavior
under live LLM calls. Drift between expected and actual surfaces immediately;
no manual eyeballing.

## Run

```bash
# Full bench (all registered modules' fixtures, real Sonnet via direct API)
BENCH_DIRECT=1 op run --env-file=.env.tpl -- npx tsx scripts/bench-modules/run.ts

# Filter by module surface/intent
op run --env-file=.env.tpl -- npx tsx scripts/bench-modules/run.ts --module=dashboard-host/rule

# Filter by fixture name (substring match)
op run --env-file=.env.tpl -- npx tsx scripts/bench-modules/run.ts --name=F14
```

Output lands in `scripts/bench-modules/out/latest.{json,md}` (gitignored).

## Status (PR1a)

PR1a ships harness scaffolding only — no fixtures.

Fixtures land per their module's PR:
- **PR1c**: rule (six fixtures — F14_reproduction, F14_drift_retry,
  conflict_awareness_happy, conflict_awareness_drift, standard_create,
  update_existing). Validated 6/6 on spike branch
  `wip/composer-modules-spike` 2026-05-04.
- **PR4**: bookings (six per book_time_with §4 scenarios)
- **PR5**: dealroom-host/* + dealroom-guest/* (~12-14 fixtures across intents)

## Adding a fixture

1. Author a `ModuleFixture` (see `types.ts`) under `fixtures/<module>.ts`.
2. Register it in `run.ts`'s `FIXTURES` array.
3. Run the bench: `BENCH_DIRECT=1 op run --env-file=.env.tpl -- npx tsx scripts/bench-modules/run.ts --name=<fixture-name>`.
4. Iterate until pass.

## Synthetic LLM injection

For fixtures that test guard retry behavior, the fixture's `composerInvoker`
field can override the live Sonnet call with a deterministic mock. Example:

```ts
composerInvoker: (() => {
  let count = 0;
  return async () => {
    count += 1;
    if (count === 1) return { text: DRIFTED_EMISSION };
    return { text: CORRECTED_EMISSION };
  };
})(),
```

Production fixtures omit `composerInvoker`; the runner's
`defaultComposerInvoker` makes live Sonnet calls.

## File-tracing invariant

Per the proposal's §2.4 + B4: every playbook fragment path is intended to be
inlined as a literal `readFileSync(join(cwd, "literal/path"))` because
Vercel's `@vercel/nft` traces statically. PR1a's runner uses a dynamic
loader; subsequent PRs (when bundling matters for production) generate
per-fragment named exports at build time.
