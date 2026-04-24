-- AlterTable: add recurrence config to NegotiationLink
ALTER TABLE "NegotiationLink" ADD COLUMN "recurrence" JSONB;

-- CreateTable: sparse per-occurrence divergence rows
CREATE TABLE "LinkOccurrence" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "originalStartAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "actualStartAt" TIMESTAMP(3),
    "actualEndAt" TIMESTAMP(3),
    "actualFormat" TEXT,
    "actualLocation" TEXT,
    "actualMeetingUrl" TEXT,
    "gcalInstanceId" TEXT,
    "divergedBy" TEXT NOT NULL,
    "divergedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "counterpartyAck" TEXT,
    "reason" TEXT,

    CONSTRAINT "LinkOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkOccurrence_linkId_originalStartAt_key" ON "LinkOccurrence"("linkId", "originalStartAt");

-- CreateIndex
CREATE INDEX "LinkOccurrence_linkId_status_idx" ON "LinkOccurrence"("linkId", "status");

-- AddForeignKey
ALTER TABLE "LinkOccurrence" ADD CONSTRAINT "LinkOccurrence_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "NegotiationLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
