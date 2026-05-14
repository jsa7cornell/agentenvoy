-- Drop the cached-title column from NegotiationSession.
--
-- All reads were removed in commit 8ebaec2 (PR1 step 1).
-- All selects were removed in this commit (PR1 step 2).
-- All writes (create/update) were removed in this commit (PR1 step 2).
--
-- Title is now always computed live via getEffectiveMeetingState(session).
-- Deploy this migration AFTER the new code is fully deployed on all Vercel
-- pods (Rule 8 — same sequencing as guestTimezone 2026-04-15 and
-- welcomeEmailSentAt 2026-04-17). Apply via Supabase SQL Editor.
--
-- Decision: proposals/2026-05-14_event-record-alignment_reviewed-2026-05-14_decided-2026-05-14.md §PR1

ALTER TABLE "NegotiationSession" DROP COLUMN IF EXISTS "title";
