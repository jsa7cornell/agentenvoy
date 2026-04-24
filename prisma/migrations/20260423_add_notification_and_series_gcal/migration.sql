-- AlterTable: add seriesGcalEventId to NegotiationLink.
-- Null for one-off links and recurring links that haven't committed an anchor
-- yet. Written at anchor commit; cleared if the series ends + master event is
-- deleted on GCal.
ALTER TABLE "NegotiationLink" ADD COLUMN "seriesGcalEventId" TEXT;

-- CreateTable: durable notification stream (per proposal 2026-04-22 R2
-- "always notify"). v1 write-only stub — no bell UI yet. See WISHLIST
-- `notification-bell-and-center` for the full feature plan.
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sessionId" TEXT,
    "linkId" TEXT,
    "linkOccurrenceId" TEXT,
    "actorKind" TEXT NOT NULL,
    "actorLabel" TEXT,
    "headline" VARCHAR(280) NOT NULL,
    "detail" TEXT,
    "ctaKind" TEXT,
    "ctaPayload" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex: partial-read queries filter on readAt IS NULL for unread count.
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
