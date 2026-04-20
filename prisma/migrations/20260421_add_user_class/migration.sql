-- Migration: add userClass column to User + seed John's row to 'admin'
-- Prisma schema:
--   User.userClass  String  @default("user")   // "user" | "admin"
--
-- F1 of the feedback-loops-and-debug-consent proposal (2026-04-20). Replaces
-- the ADMIN_EMAIL env-var gate in src/lib/admin-auth.ts with a first-class
-- column on User. The env-var check stays as a 24-48h fallback in the code;
-- the very next PR removes the fallback once we've verified the new gate.
--
-- Both statements run in a single transaction per PLAYBOOK Rule 12. Column
-- is additive (NOT NULL with default "user" — existing rows backfill
-- atomically on ALTER). John's seed is idempotent: re-running the UPDATE
-- on an already-seeded row is a no-op, and if John's email isn't in the
-- table yet (first-time local dev), the UPDATE matches zero rows and the
-- migration still succeeds.
--
-- Rollback: this migration is additive. To revert, flip the code gate back
-- to ADMIN_EMAIL email-match (the fallback path already works); leave the
-- column in place. If the column must be dropped, that's a follow-up
-- `ALTER TABLE "User" DROP COLUMN "userClass";` with code-already-gone.

BEGIN;

ALTER TABLE "User"
  ADD COLUMN "userClass" TEXT NOT NULL DEFAULT 'user';

-- Seed the one current admin. Scoped to a literal email so the migration
-- is self-contained (no env-var read at migration time). If ADMIN_EMAIL
-- is ever set to a different address in prod, a follow-up one-line UPDATE
-- seeds that row too — but that's the exact case the userClass column
-- exists to eliminate going forward.
UPDATE "User"
  SET "userClass" = 'admin'
  WHERE "email" = 'jsa7cornell@gmail.com';

COMMIT;
