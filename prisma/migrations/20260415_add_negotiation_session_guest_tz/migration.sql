-- Add guestTimezone column for persisting guest browser-detected IANA timezone.
-- First-write-wins: populated on the first session visit where the browser
-- supplied a timezone, and never overwritten on subsequent visits.
ALTER TABLE "NegotiationSession"
  ADD COLUMN "guestTimezone" TEXT;
