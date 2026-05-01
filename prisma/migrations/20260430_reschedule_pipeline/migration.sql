-- Reschedule pipeline: 4 columns on NegotiationSession + new RescheduleAttempt table
-- Proposal: 2026-04-29_mcp-reschedule-meeting-patch-in-place_*_decided-2026-04-30.md
--
-- Per the §B2 fold:
--   - finalizesAt + supersededByRescheduleId ship UNWIRED in this PR.
--     finalizesAt is written by confirm-pipeline (out of scope here);
--     supersededByRescheduleId is reserved for the chain pattern (future).
--   - rescheduleHistory + lastRescheduledAt ARE wired by reschedule-pipeline.
--
-- Per the §B5 fold:
--   - RescheduleAttempt mirrors ConfirmAttempt for idempotent replay.
--     Same-(sessionId, idempotencyKey) returns the original responseBody.

-- AlterTable: 4 new columns on NegotiationSession
ALTER TABLE "NegotiationSession" ADD COLUMN     "finalizesAt" TIMESTAMP(3),
ADD COLUMN     "lastRescheduledAt" TIMESTAMP(3),
ADD COLUMN     "rescheduleHistory" JSONB,
ADD COLUMN     "supersededByRescheduleId" TEXT;

-- CreateTable
CREATE TABLE "RescheduleAttempt" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "fromStart" TIMESTAMP(3) NOT NULL,
    "toStart" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT NOT NULL,
    "responseBody" JSONB,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RescheduleAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RescheduleAttempt_sessionId_idempotencyKey_idx" ON "RescheduleAttempt"("sessionId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "RescheduleAttempt_sessionId_createdAt_idx" ON "RescheduleAttempt"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "RescheduleAttempt_outcome_createdAt_idx" ON "RescheduleAttempt"("outcome", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NegotiationSession_supersededByRescheduleId_key" ON "NegotiationSession"("supersededByRescheduleId");

-- AddForeignKey
ALTER TABLE "RescheduleAttempt" ADD CONSTRAINT "RescheduleAttempt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NegotiationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

