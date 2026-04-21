-- Agent-accessible feedback pipeline (proposals/2026-04-21_agent-accessible-feedback-pipeline_*).
-- Additive. Safe to run before code deploy (new columns default safely; the
-- AgentAccessToken table is only read by the new routes this PR ships).

ALTER TABLE "FeedbackReport"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS "area" TEXT,
  ADD COLUMN IF NOT EXISTS "clientState" JSONB;

CREATE INDEX IF NOT EXISTS "FeedbackReport_status_createdAt_idx"
  ON "FeedbackReport"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "FeedbackReport_area_createdAt_idx"
  ON "FeedbackReport"("area", "createdAt");

CREATE TABLE IF NOT EXISTS "AgentAccessToken" (
  "id"          TEXT PRIMARY KEY,
  "reportId"    TEXT NOT NULL REFERENCES "FeedbackReport"("id") ON DELETE CASCADE,
  "mintedById"  TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "jti"         TEXT NOT NULL,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "usedAt"      TIMESTAMP(3),
  "fetchCount"  INTEGER NOT NULL DEFAULT 0,
  "revokedAt"   TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentAccessToken_jti_key"
  ON "AgentAccessToken"("jti");
CREATE INDEX IF NOT EXISTS "AgentAccessToken_reportId_idx"
  ON "AgentAccessToken"("reportId");
CREATE INDEX IF NOT EXISTS "AgentAccessToken_mintedById_idx"
  ON "AgentAccessToken"("mintedById");
CREATE INDEX IF NOT EXISTS "AgentAccessToken_expiresAt_idx"
  ON "AgentAccessToken"("expiresAt");
