-- Migration: SessionInvitee + InviteeSlotRsvp + SessionParticipant evolution.
-- Rule 12: run this SQL in Supabase BEFORE deploying code.
-- Track 1 of proposal 2026-04-23_multi-user-coordination-simple-and-complex.
--
-- Changes:
--   1. Create SessionInvitee (the invite — host-defined, stable).
--   2. Create InviteeSlotRsvp (per-slot per-invitee RSVP, partial-attendance).
--   3. Drop SessionParticipant_sessionId_key (multiple arrivals per session).
--   4. Add SessionParticipant.sessionInviteeId FK (arrival may fulfill invite).
--   5. Backfill: for every NegotiationSession whose NegotiationLink has
--      inviteeNames non-empty, insert one SessionInvitee per name. If an
--      existing SessionParticipant row matches on email, link it.
--
-- No destructive drops of existing data. Existing SessionParticipant rows
-- keep their sessionInviteeId = NULL (uninvited / pre-split arrivals — the
-- app-layer treats NULL as "legacy or uninvited click-through" and that's
-- behaviorally correct for both the group-link flow and Track 1 v1).

-- 1. SessionInvitee
CREATE TABLE "SessionInvitee" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'guest',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionInvitee_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SessionInvitee_sessionId_idx" ON "SessionInvitee"("sessionId");
CREATE INDEX "SessionInvitee_linkId_idx" ON "SessionInvitee"("linkId");

ALTER TABLE "SessionInvitee" ADD CONSTRAINT "SessionInvitee_linkId_fkey"
    FOREIGN KEY ("linkId") REFERENCES "NegotiationLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionInvitee" ADD CONSTRAINT "SessionInvitee_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "NegotiationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. InviteeSlotRsvp
CREATE TABLE "InviteeSlotRsvp" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sessionInviteeId" TEXT NOT NULL,
    "slotStart" TIMESTAMP(3) NOT NULL,
    "slotEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteeSlotRsvp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InviteeSlotRsvp_sessionId_sessionInviteeId_idx"
    ON "InviteeSlotRsvp"("sessionId", "sessionInviteeId");
CREATE INDEX "InviteeSlotRsvp_sessionInviteeId_slotStart_idx"
    ON "InviteeSlotRsvp"("sessionInviteeId", "slotStart");

ALTER TABLE "InviteeSlotRsvp" ADD CONSTRAINT "InviteeSlotRsvp_sessionInviteeId_fkey"
    FOREIGN KEY ("sessionInviteeId") REFERENCES "SessionInvitee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InviteeSlotRsvp" ADD CONSTRAINT "InviteeSlotRsvp_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "NegotiationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. SessionParticipant: drop @unique(sessionId), add sessionInviteeId.
ALTER TABLE "SessionParticipant" DROP CONSTRAINT IF EXISTS "SessionParticipant_sessionId_key";
ALTER TABLE "SessionParticipant" ADD COLUMN "sessionInviteeId" TEXT;

CREATE INDEX "SessionParticipant_sessionId_idx" ON "SessionParticipant"("sessionId");
CREATE INDEX "SessionParticipant_sessionInviteeId_idx" ON "SessionParticipant"("sessionInviteeId");

ALTER TABLE "SessionParticipant" ADD CONSTRAINT "SessionParticipant_sessionInviteeId_fkey"
    FOREIGN KEY ("sessionInviteeId") REFERENCES "SessionInvitee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Backfill SessionInvitee rows for existing multi-invitee sessions.
-- For each active NegotiationSession whose link.inviteeNames is non-empty,
-- emit one SessionInvitee row per name. Uses md5(random()::text || name)
-- for a non-colliding cuid-shaped id since gen_random_uuid is guaranteed
-- on pg13+; we prefix with 'seed' to distinguish backfilled rows.
INSERT INTO "SessionInvitee" ("id", "linkId", "sessionId", "name", "email", "role", "createdAt")
SELECT
    'seed_' || substr(md5(random()::text || clock_timestamp()::text || s.id || name_val), 1, 20),
    l.id,
    s.id,
    name_val,
    CASE WHEN s.id IS NOT NULL THEN l."inviteeEmail" ELSE NULL END,  -- best-guess: only the first-slot invitee gets the email
    'guest',
    NOW()
FROM "NegotiationSession" s
JOIN "NegotiationLink" l ON l.id = s."linkId"
CROSS JOIN LATERAL unnest(l."inviteeNames") AS name_val
WHERE array_length(l."inviteeNames", 1) IS NOT NULL
  AND array_length(l."inviteeNames", 1) > 0
  AND NOT EXISTS (
      SELECT 1 FROM "SessionInvitee" si
      WHERE si."sessionId" = s.id AND si."name" = name_val
  );

-- Link existing SessionParticipant rows to their SessionInvitee by matching
-- on (sessionId, email) when email is set. Rows with no email match stay
-- with sessionInviteeId = NULL (treated as uninvited/legacy by app layer).
UPDATE "SessionParticipant" sp
SET "sessionInviteeId" = si.id
FROM "SessionInvitee" si
WHERE si."sessionId" = sp."sessionId"
  AND si."email" IS NOT NULL
  AND sp."email" IS NOT NULL
  AND lower(si."email") = lower(sp."email")
  AND sp."sessionInviteeId" IS NULL;
