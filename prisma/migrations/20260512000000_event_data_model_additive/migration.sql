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
-- NegotiationSession.meetingNotesRegens which has a DEFAULT 0 (Postgres 11+
-- adds these as metadata-only changes, no table rewrite).
--
-- IF NOT EXISTS guards added 2026-05-12 after a prior in-flight apply
-- partially added `customTitle` (error: "column already exists") but didn't
-- record a `_prisma_migrations` row. Idempotency lets this migration re-run
-- against any combination of already-applied / not-yet-applied columns.
-- Standard pattern for additive Postgres migrations.

ALTER TABLE "NegotiationLink"
  ADD COLUMN IF NOT EXISTS "customTitle" TEXT,
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "creationPrompt" TEXT;

ALTER TABLE "NegotiationSession"
  ADD COLUMN IF NOT EXISTS "meetingNotesRegens" INTEGER NOT NULL DEFAULT 0;
