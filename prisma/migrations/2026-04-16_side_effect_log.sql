-- Migration: add SideEffectLog table for the side-effect dispatcher.
-- Run this in Supabase Dashboard → SQL Editor → New query BEFORE deploying
-- the code that references the model (Prisma generate will fail on Vercel
-- otherwise — the client is built against the schema).
--
-- Additive migration, safe to run on production. No existing rows are touched.

CREATE TABLE "SideEffectLog" (
    "id"            TEXT PRIMARY KEY,
    "kind"          TEXT NOT NULL,
    "mode"          TEXT NOT NULL,
    "status"        TEXT NOT NULL,
    "targetSummary" TEXT NOT NULL,
    "payload"       JSONB NOT NULL,
    "contextJson"   JSONB,
    "providerRef"   TEXT,
    "error"         TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "SideEffectLog_kind_createdAt_idx"   ON "SideEffectLog" ("kind",   "createdAt");
CREATE INDEX "SideEffectLog_status_createdAt_idx" ON "SideEffectLog" ("status", "createdAt");

-- Optional sanity check:
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'SideEffectLog';
