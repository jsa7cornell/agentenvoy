-- Deal-room feedback symmetry (2026-04-21 proposal, decided same day).
-- Additive: three new columns on FeedbackReport + one new index.
-- Also relaxes userText to nullable so Haiku-prefilled submissions can
-- ship verbatim when the user doesn't edit the gray draft.
--
-- Deploy order (Rule 12): SQL here via Supabase SQL Editor BEFORE Vercel
-- deploys the new code — the writer sets `filedByGuest: true` and expects
-- the column to exist.

ALTER TABLE "FeedbackReport"
    ADD COLUMN "filedByGuest" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "guestName" TEXT,
    ADD COLUMN "guestEmail" TEXT;

ALTER TABLE "FeedbackReport"
    ALTER COLUMN "userText" DROP NOT NULL;

CREATE INDEX "FeedbackReport_filedByGuest_createdAt_idx"
    ON "FeedbackReport"("filedByGuest", "createdAt");
