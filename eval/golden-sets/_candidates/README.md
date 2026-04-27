# `_candidates/` — golden-set candidate dump

This directory holds **candidate** turns extracted from production for
John's Phase 5 curation pass. The actual `*.jsonl` files in this
directory are gitignored — only this README and the `.gitkeep` are
checked in.

## Lifecycle

```
production DB (Message + NegotiationSession)
        │
        │  npm run eval:extract-candidates -- --days=60
        ▼
eval/golden-sets/_candidates/host.jsonl    (untracked)
eval/golden-sets/_candidates/guest.jsonl   (untracked)
        │
        │  John's Phase 5 curation session — keep/drop/edit each row
        │  add expected_intent + expected_tone columns
        ▼
eval/golden-sets/host.jsonl                (checked in, frozen)
eval/golden-sets/guest.jsonl               (checked in, frozen)
```

## To regenerate the candidate set

```bash
npm run eval:extract-candidates -- --days=60
```

Flags:

- `--days=N` — trailing window (default 60, max 180)
- `--out-dir=PATH` — override output directory (default this folder)
- `--max-per-role=N` — cap per role (default 500; pre-curation, NOT the
  final 100)
- `--dry-run` — parse + scrub but do not write

The script reads `DATABASE_URL` from the environment and instantiates
its own `PrismaClient` (not via `@/lib/prisma`, which is the runtime
path).

## What's in each row

See `scripts/eval-candidates/extract.ts` for the full type. Each line
is one JSON object with the scrubbed message content, an anonymized
session id (so multi-turn excerpts can be grouped), the prior turn for
context, and a few session-level fields (link type, status, format,
duration).

## PII scrub

Names (allowlisted from session.guestName / link.inviteeName /
link.inviteeNames / host.user.name), emails, and phone numbers are
redacted. URLs pass through. See `scripts/eval-candidates/pii-scrub.ts`
for the full ruleset.

## After Phase 5 curation

The curated output goes one level up at `eval/golden-sets/host.jsonl`
and `eval/golden-sets/guest.jsonl` — those are the files Promptfoo
will run as testCases. They are checked in and frozen unless explicitly
bumped via a documented "golden set refresh" PR.
