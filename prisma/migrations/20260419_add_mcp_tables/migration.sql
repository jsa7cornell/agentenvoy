-- Migration: MCP two-Envoy handshake schema additions.
-- See proposals/2026-04-18_mcp-spec-draft_reviewed-2026-04-19_decided-2026-04-19.md.
--
-- Additive migration — three pieces:
--   1. NegotiationLink.hashSalt — per-link salt for guest-email hashing,
--      so cross-link correlation is impossible (SPEC §4). Seeded via
--      Postgres builtin gen_random_uuid() (pg ≥13, no pgcrypto needed).
--      Existing rows get a fresh salt on backfill.
--   2. MCPRateCounter — UPSERT counter for per-token/per-tool rate limits.
--      Atomicity under READ COMMITTED proven by the
--      rate-limit-counter.test.ts integration test (SPEC §1).
--   3. ConsentRequest — host consent record; propose_lock refuses on any
--      {pending, retracted, expired} row for the target field (SPEC §2).

-- 1. Per-link hash salt for guest-email hashing.
ALTER TABLE "NegotiationLink"
  ADD COLUMN "hashSalt" TEXT NOT NULL DEFAULT gen_random_uuid()::text;

-- 2. MCP rate-limit counter.
CREATE TABLE "MCPRateCounter" (
    "id"            TEXT PRIMARY KEY,
    "tokenHash"     TEXT NOT NULL,
    "tool"          TEXT NOT NULL,
    "windowStart"   TIMESTAMP(3) NOT NULL,
    "count"         INTEGER NOT NULL DEFAULT 1,
    "expiresAt"     TIMESTAMP(3) NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "MCPRateCounter_tokenHash_tool_windowStart_key"
  ON "MCPRateCounter" ("tokenHash", "tool", "windowStart");
CREATE INDEX "MCPRateCounter_expiresAt_idx"
  ON "MCPRateCounter" ("expiresAt");

-- 3. Host consent request.
CREATE TABLE "ConsentRequest" (
    "id"                TEXT PRIMARY KEY,
    "linkId"            TEXT NOT NULL,
    "sessionId"         TEXT,
    "field"             TEXT NOT NULL,
    "appliedValue"      JSONB NOT NULL,
    "rationaleTemplate" TEXT,
    "rationaleProse"    TEXT,
    "status"            TEXT NOT NULL DEFAULT 'pending',
    "decidedBy"         TEXT,
    "decidedAt"         TIMESTAMP(3),
    "expiresAt"         TIMESTAMP(3) NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConsentRequest_linkId_fkey"
      FOREIGN KEY ("linkId") REFERENCES "NegotiationLink"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ConsentRequest_linkId_field_status_idx"
  ON "ConsentRequest" ("linkId", "field", "status");
CREATE INDEX "ConsentRequest_sessionId_status_idx"
  ON "ConsentRequest" ("sessionId", "status");
CREATE INDEX "ConsentRequest_expiresAt_idx"
  ON "ConsentRequest" ("expiresAt");

-- Sanity check:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'MCPRateCounter';
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'ConsentRequest';
