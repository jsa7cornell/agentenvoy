-- Add NegotiationSession.negotiatedDuration column.
--
-- Reusable-link guest-picks proposal, decided 2026-04-28
-- (proposals/2026-04-28_reusable-link-guest-picks-and-composer-awareness_*).
--
-- Stores the guest-negotiated meeting duration (minutes) when the host has
-- opted into guestPicks.duration on the link. Mirrors the existing
-- negotiated{Activity,Location,Format} pattern from the 2026-04-22
-- guest-activity-location-negotiation proposal.
--
-- Read at slot-search and confirm time as
--   session.negotiatedDuration ?? link.parameters.duration
-- and cleared by handleUpdateLinkRules / availability-rules edit / primary-link
-- defaults change when the host edits the parent link's duration.
--
-- Additive, NULL-default, no backfill needed. Existing rows resolve as if the
-- column were absent.

ALTER TABLE "NegotiationSession"
  ADD COLUMN "negotiatedDuration" INTEGER;
