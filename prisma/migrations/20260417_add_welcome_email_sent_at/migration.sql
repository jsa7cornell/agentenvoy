-- Migration: add User.welcomeEmailSentAt for the welcome email gate.
-- Run this in Supabase Dashboard → SQL Editor → New query BEFORE deploying
-- the code that references the column.
--
-- Additive + idempotent. Backfills existing users so they don't receive
-- a retroactive welcome email on their next sign-in (the signIn callback
-- would otherwise see a null stamp and dispatch).

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "welcomeEmailSentAt" TIMESTAMP(3);

UPDATE "User"
  SET "welcomeEmailSentAt" = "createdAt"
  WHERE "welcomeEmailSentAt" IS NULL;

-- Sanity check:
-- SELECT COUNT(*) FROM "User" WHERE "welcomeEmailSentAt" IS NULL;  -- expect 0
