-- Migration: add wantsReminder column to NegotiationSession
-- Prisma schema: NegotiationSession.wantsReminder Boolean @default(true)
--
-- Run this in Supabase SQL Editor BEFORE the Vercel deploy that includes
-- the schema.prisma and emails-host-notify-reminder-2026-04-17 branch changes.
-- Additive migration — safe to run first (old code ignores the new column).

ALTER TABLE "NegotiationSession"
  ADD COLUMN IF NOT EXISTS "wantsReminder" BOOLEAN NOT NULL DEFAULT TRUE;
