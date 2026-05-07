-- AlterTable: add bufferCalendarEventId to NegotiationSession
-- PR-E 2026-05-06 — buffer becomes a real paired GCal event
ALTER TABLE "NegotiationSession" ADD COLUMN "bufferCalendarEventId" TEXT;
