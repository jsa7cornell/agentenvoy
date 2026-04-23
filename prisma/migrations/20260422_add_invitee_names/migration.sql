-- Migration: add inviteeNames String[] to NegotiationLink
-- Rule 12: run this SQL in Supabase before deploying code.
-- inviteeName is NOT dropped — kept as deprecated read bridge for 2 weeks.
-- Follow-up migration drops inviteeName once logs confirm zero reads.

ALTER TABLE "NegotiationLink" ADD COLUMN "inviteeNames" TEXT[] NOT NULL DEFAULT '{}';

-- Backfill: copy existing single inviteeName into the array
UPDATE "NegotiationLink"
SET "inviteeNames" = ARRAY["inviteeName"]
WHERE "inviteeName" IS NOT NULL AND "inviteeName" <> '';
