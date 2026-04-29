-- Add NegotiationLink.lastMaterialEditAt + lastEditedFields columns.
--
-- Event-edit handler + composer fix proposal, decided 2026-04-28
-- (proposals/2026-04-28_event-edit-unified-intent_reviewed-2026-04-28_decided-2026-04-28.md, §3.C).
--
-- Powers the "Edited 2 min ago — activity, hours" pill on the link/event card.
-- Set whenever update_link patches a field in MATERIAL_FIELDS (see
-- src/lib/material-fields.ts). Non-material edits (e.g. lastResort flip,
-- intent.steering recompute) bump only `updatedAt`, leaving these columns
-- untouched so the pill doesn't render for them.
--
-- Additive, NULL-default. Backfill: existing rows leave both columns
-- null/empty; the pill freshness check (`lastMaterialEditAt > now() - 5min`)
-- fails on null so no pill renders for pre-migration rows.

ALTER TABLE "NegotiationLink"
  ADD COLUMN IF NOT EXISTS "lastMaterialEditAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastEditedFields"   TEXT[] NOT NULL DEFAULT '{}';
