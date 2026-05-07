-- FB-2: Add structured failure-mode tags to FeedbackReport
-- text[] instead of JSONB: typed, GIN-indexable, simpler array ops for dashboard queries.
-- Additive, safe to run on live table.
ALTER TABLE "FeedbackReport" ADD COLUMN "tags" TEXT[];
