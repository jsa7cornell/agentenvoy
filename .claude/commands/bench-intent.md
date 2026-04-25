---
description: Run the dashboard-chat intent classifier against a parameterized synthetic corpus. Surfaces ambiguous/failed cases back into chat.
argument-hint: [scenario description] [axis] [count]
---

Run the intent classifier bench test.

**Arguments** (parse from the user's natural-language invocation):

- `scenario` — free-text description of the seeded context. Parse into `{ host, activeSessions[], calendar[], recentTurns[] }`. Named presets supported: `"john-jon-bike-ride"`, `"john-bob-quarterly"`, `"empty-new-host"`. If the scenario doesn't match a preset and can't be parsed structurally, ask John to clarify before running.
- `axis` — the variation dimension to synthesize utterances along. Examples: `"short affirmatives after Envoy clarifier"`, `"bare-noun continuations"`, `"echo of prior envoy reply"`, `"multi-intent conjunctions"`, `"ambiguous pronouns"`, `"off-topic injections"`. Default: `"mixed adversarial"`.
- `count` — number of utterances to synthesize. Default: 30. Cap at 100.

**Steps**:

1. Parse the scenario + axis + count from the user's message. If the scenario is ambiguous or doesn't match a preset and can't be understood, ask John to clarify before proceeding.

2. Print a one-line confirmation:
   > Running bench: `<scenario summary>`, axis=`<axis>`, count=`<count>`.

3. Invoke the runner:
   ```bash
   cd app && op run --env-file=.env.tpl -- env BENCH_DIRECT=1 npm run bench:intent -- \
     --scenario='<preset name or serialized JSON>' \
     --axis='<axis>' \
     --count=<count>
   ```

4. Read `app/scripts/bench-intent/out/latest-results.json`.

5. Format results as a markdown table back into chat:
   - Header: **X/Y passed, Z flagged**
   - Failure table columns: `utterance` | `predicted` | `expected` | `clarifier (if any)` | `flag reason`
   - Cap at 30 rows; if more, show first 30 + "(N more in `out/latest-results.csv`)"
   - If 0 failures, say "✓ All passed" with a one-line note on the axis tested.

6. If ≥1 failure, offer:
   > Want me to add the flagged utterances to the regression suite at `src/__tests__/integration/chat-intent-classification.test.ts`?
   
   **Wait for John's confirmation before editing any test files.**

7. Done. Total wall-clock target: ≤5 min for count≤50.

---

**Preset reference:**

| Preset name | Host | Active sessions | Envoy context |
|---|---|---|---|
| `john-jon-bike-ride` | John | Jon (qx4bmg, active) | Envoy asked "did you mean to send a new request?" |
| `john-bob-quarterly` | John | Bob (p2xq9k, active) | No prior Envoy turn |
| `empty-new-host` | John | None | No prior Envoy turn |

**Axis reference:**

- `short affirmatives after Envoy clarifier` — "new", "yes", "go ahead", "sure"
- `bare-noun continuations` — "bike ride", "1:1", "call", "coffee"
- `echo of prior envoy reply` — near-verbatim echoes of the most recent Envoy message
- `multi-intent conjunctions` — "Book Bob at 2 AND update my phone to 555-1234"
- `ambiguous pronouns` — "move it to Tuesday", "change that"
- `off-topic injections` — utterances outside the five classification tiers
- `mixed adversarial` — default; samples across all axes
