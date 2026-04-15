-- Tentative protective hold placed on a specific stretch slot by explicit
-- host decision in the dashboard thread. Host-initiated only; never
-- automatic. Expires after 48h or when the session's meeting is confirmed.
CREATE TABLE "Hold" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "hostId" TEXT NOT NULL,
  "slotStart" TIMESTAMP(3) NOT NULL,
  "slotEnd" TIMESTAMP(3) NOT NULL,
  "calendarEventId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Hold_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Hold_sessionId_idx" ON "Hold"("sessionId");
CREATE INDEX "Hold_hostId_idx" ON "Hold"("hostId");
CREATE INDEX "Hold_status_expiresAt_idx" ON "Hold"("status", "expiresAt");

ALTER TABLE "Hold" ADD CONSTRAINT "Hold_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "NegotiationSession"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
