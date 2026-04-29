-- Add NegotiationLink.topicSource column.
--
-- Event-edit handler + composer fix proposal, decided 2026-04-28
-- (proposals/2026-04-28_event-edit-unified-intent_reviewed-2026-04-28_decided-2026-04-28.md).
--
-- Records the provenance of `link.topic` so the title-rebuild rule on activity
-- edits can be deterministic instead of text-matching against the activity
-- vocabulary.
--
--   "activity"  → topic was activity-derived (e.g. "Bike ride" set when LLM
--                 extracted activity = "bike ride" at create time). On
--                 activity change, clear topic and topicSource so the title
--                 ladder falls through to format/name templates.
--   "custom"    → topic is a host-set phrase like "Q3 review". Preserve
--                 across activity edits.
--   NULL        → no topic was ever set (filtered as generic, or never given).
--
-- Backfill — existing rows: deterministic classification based on whether the
-- prior topic value matches an entry in app/src/lib/activity-vocab.ts. Names
-- and aliases are listed below; these MUST stay in sync with the canonical
-- module if the vocab grows. Rows whose topic doesn't match anything are
-- classified as "custom".
--
-- John's framing: "if the title includes something that changed, the title
-- should change" — provenance makes that rule deterministic.

ALTER TABLE "NegotiationLink"
  ADD COLUMN "topicSource" TEXT;

-- Backfill. The vocab/aliases below mirror app/src/lib/activity-vocab.ts as
-- of 2026-04-28. If the vocab list grows after this migration ships, future
-- rows go through the application write path (deriveTopicSource) and get the
-- correct provenance — only this one-time backfill uses the static list.
UPDATE "NegotiationLink"
SET "topicSource" = CASE
  WHEN "topic" IS NULL THEN NULL
  WHEN LOWER(TRIM("topic")) IN (
    -- canonical names
    'coffee', 'breakfast', 'lunch', 'dinner', 'drinks', 'bike ride',
    'hike', 'run', 'walk', 'surf', 'yoga', 'workout', 'swim',
    'brainstorm', 'intro', 'interview',
    -- aliases
    'cafe', 'café',
    'brunch',
    'cocktails', 'happy hour',
    'bike', 'biking', 'cycling', 'cycle',
    'hiking', 'trail',
    'running', 'jog', 'jogging', 'trail run',
    'walking',
    'surfing',
    'gym', 'training', 'lift',
    'swimming',
    'brainstorming',
    'introduction', 'meet-and-greet'
  ) THEN 'activity'
  ELSE 'custom'
END;
