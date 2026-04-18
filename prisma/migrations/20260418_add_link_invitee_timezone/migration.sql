-- Add inviteeTimezone column on NegotiationLink for host-declared guest IANA
-- timezone. Seeds session.guestTimezone at session-creation time; acts as a
-- soft-lock until the greeting re-render path ships.
ALTER TABLE "NegotiationLink"
  ADD COLUMN "inviteeTimezone" TEXT;
