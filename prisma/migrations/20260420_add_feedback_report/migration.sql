-- F3: FeedbackReport — user-submitted feedback bundle with transparent consent.
-- Additive: new table only, no changes to existing tables.

CREATE TABLE "FeedbackReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userText" TEXT NOT NULL,
    "triedToDoText" TEXT,
    "userAgent" TEXT,
    "url" TEXT,
    "checklistState" JSONB NOT NULL,
    "bundle" JSONB NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FeedbackReport_userId_idx" ON "FeedbackReport"("userId");
CREATE INDEX "FeedbackReport_createdAt_idx" ON "FeedbackReport"("createdAt");
CREATE INDEX "FeedbackReport_resolved_createdAt_idx" ON "FeedbackReport"("resolved", "createdAt");

ALTER TABLE "FeedbackReport" ADD CONSTRAINT "FeedbackReport_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
