# Golden sets — host + guest curated dialog turns

This directory holds the frozen golden sets used by the Promptfoo eval.
Two files are checked in:

- `host.jsonl` — host-role turns (dashboard chat).
- `guest.jsonl` — guest-role turns (deal-room dialog).

## Status — Phase 5 PR 1 placeholder

The current `host.jsonl` and `guest.jsonl` are **5-turn placeholders**
hand-authored to exercise the eval harness end-to-end. They are NOT
John's curated set. **Phase 5 PR 2** swaps these in for the curated
100-turn-per-role frozen set produced from John's review of the
Phase 4 candidate dump (see `_candidates/README.md`).

Until the real set lands, do not draw conclusions from Promptfoo eval
output. The harness is wired up; the data is not yet representative.

## Row schema

Each line is one Promptfoo test case. The shape Promptfoo expects:

```json
{
  "description": "guest: pick one of three proposed slots",
  "vars": {
    "utterance": "The Wednesday morning option works for me.",
    "context": {
      "session_status": "active",
      "link_type": "primary"
    }
  },
  "metadata": {
    "expected_intent": "schedule",
    "expected_tone_notes": "warm confirm; lock the slot; one short sentence"
  }
}
```

`vars` are interpolated into the prompt template via Promptfoo's
`{{utterance}}` Mustache substitution. `metadata` is read by the
LLM-as-judge rubric to compare expected vs. actual behavior.

## Phase 4 candidate row → curated row

Phase 4's `scripts/eval-candidates/extract.ts` emits rows with a
different shape (`session_id_anon`, `turn_index`, `role`,
`content_scrubbed`, `context`, etc. — see `_candidates/README.md`).
**That shape is intentional** — those rows are pre-curation and need
the role split, scrub-replacement count, and turn-index for John's
review pass. The shape transforms during curation:

```
candidate row              →  curated row (this directory)
---------------------------    ------------------------------------
session_id_anon            →  metadata.session_id_anon (optional)
turn_index                 →  metadata.turn_index (optional)
role                       →  routing — host.jsonl vs. guest.jsonl
content_scrubbed           →  vars.utterance
context.{...}              →  vars.context.{...}
                           +  metadata.expected_intent  (NEW — John adds)
                           +  metadata.expected_tone_notes  (NEW — John adds)
```

The transform happens during John's curation pass — not via an
automated adapter — so John can edit utterances in place while marking
keep/drop/edit. If a future PR ever needs to bulk-import candidate
rows without curation, an `adapt-golden-set.ts` script can be added
here; today's PR doesn't ship one because it would have no caller.

## Refresh discipline

Per CODEBASE-CLEANUP item 9:

> Frozen unless explicitly bumped via a documented "golden set refresh"
> PR. Refresh cadence: opportunistic — refresh when classifier
> accuracy on real production drops below threshold for two weeks
> running, or when a new intent class lands.

A refresh PR should:

1. Re-run `npm run eval:extract-candidates` against the latest 60-day
   window.
2. Curate (John).
3. Diff the new vs. old `host.jsonl` / `guest.jsonl` in the PR body so
   reviewers can see what's changed.
4. Re-run Promptfoo locally against both old and new sets and report
   per-rubric-dimension delta.
