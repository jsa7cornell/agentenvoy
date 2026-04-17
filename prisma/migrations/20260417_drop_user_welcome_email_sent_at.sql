-- Migration: drop User.welcomeEmailSentAt.
--
-- THIS MUST RUN *AFTER* the code that removes every read/write of
-- `welcomeEmailSentAt` has deployed. Deploy order:
--
--   1. Run 20260417_sideeffectlog_user_purpose_idx.sql (additive, safe anytime)
--   2. Merge + deploy the code that switches dispatchWelcomeEmailOnce to the
--      SideEffectLog gate and drops the field from schema.prisma
--   3. Run THIS migration to drop the column
--
-- The column was a mistake: a per-email stamp on User doesn't scale beyond
-- the first email type, and the "add column + forget to run migration"
-- pattern took prod down on 2026-04-17. The replacement is the existing
-- SideEffectLog table, gated through hasDispatchedFor() in the dispatcher.
-- See LOG entry 2026-04-17 for the full rationale.
--
-- Additive-inverse + idempotent.

ALTER TABLE "User" DROP COLUMN IF EXISTS "welcomeEmailSentAt";
