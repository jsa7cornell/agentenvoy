-- Migration: add cancellation metadata columns to NegotiationSession
-- Prisma schema:
--   NegotiationSession.cancelledAt       DateTime?
--   NegotiationSession.cancelledByRole   String?
--   NegotiationSession.cancellationNote  String?  @db.Text
--
-- Part of the calendar-popup-cancel-reschedule-ctas work (proposal
-- 2026-04-20). Backs the shared cancelSession() pipeline in
-- src/lib/cancel-pipeline.ts — callers record who cancelled, when, and
-- an optional freeform note surfaced in the deal-room system message.
--
-- All columns nullable — additive, safe to run ahead of the deploy.
-- Existing cancelled rows (if any) remain with nulls, which the UI
-- handles as "no metadata captured" and falls back to the legacy
-- statusLabel for display.

ALTER TABLE "NegotiationSession"
  ADD COLUMN IF NOT EXISTS "cancelledAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelledByRole"      TEXT,
  ADD COLUMN IF NOT EXISTS "cancellationNote"     TEXT,
  ADD COLUMN IF NOT EXISTS "gcalDriftFirstSeenAt" TIMESTAMP(3);
