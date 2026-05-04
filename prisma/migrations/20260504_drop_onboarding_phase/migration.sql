-- Drop User.onboardingPhase column.
--
-- This column tracked progress through the legacy 9-phase onboarding state
-- machine (`/api/onboarding/chat` + `src/lib/onboarding-machine.ts`). The
-- machine was retired 2026-04-26 (PR #142, seed-everything makes calibration
-- happen at signup) and the dead code was deleted 2026-05-04. Column is
-- unread by all surviving code paths; safe to drop.

ALTER TABLE "User" DROP COLUMN "onboardingPhase";
