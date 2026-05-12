-- Event data model additive migration.
--
-- Adds new columns for the 2026-05-12 event-data-model-google-aligned-and-meeting-tip
-- proposal (decided 2026-05-12). Additive ONLY — no drops. The `topic` and
-- `topicSource` columns continue to be populated during the migration window
-- (PR-2 will dual-write; PR-3 will switch readers; PR-4 — deferred ≥3 weeks
-- after PR-3 — will drop them).
--
-- Safe to apply against production: column adds are non-locking on Postgres
-- with NULL defaults, and the only NOT NULL addition is on
-- NegotiationSession.meetingNotesRegens which has a DEFAULT 0 (Postgres can
-- backfill existing rows without a table rewrite for INT4 default).

ALTER TABLE "NegotiationLink"
  ADD COLUMN "customTitle" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "creationPrompt" TEXT;

ALTER TABLE "NegotiationSession"
  ADD COLUMN "meetingNotesRegens" INTEGER NOT NULL DEFAULT 0;
