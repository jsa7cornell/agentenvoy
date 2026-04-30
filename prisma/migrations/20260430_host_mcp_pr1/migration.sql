-- PR-1: Host-side MCP — HostAccessToken table + MCPCallLog extension
-- Proposal: 2026-04-29_host-side-mcp-act-as-me_reviewed-2026-04-29_decided-2026-04-29.md

-- HostAccessToken: personal access tokens for /api/mcp/host
CREATE TABLE "HostAccessToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "displayId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopes" TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostAccessToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HostAccessToken_tokenHash_key" ON "HostAccessToken"("tokenHash");
CREATE INDEX "HostAccessToken_userId_revokedAt_idx" ON "HostAccessToken"("userId", "revokedAt");
CREATE INDEX "HostAccessToken_tokenHash_idx" ON "HostAccessToken"("tokenHash");

ALTER TABLE "HostAccessToken" ADD CONSTRAINT "HostAccessToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MCPCallLog: make linkId nullable (host-side calls have no link), add userId
ALTER TABLE "MCPCallLog" ADD COLUMN "userId" TEXT;
ALTER TABLE "MCPCallLog" ALTER COLUMN "linkId" DROP NOT NULL;

CREATE INDEX "MCPCallLog_userId_ts_idx" ON "MCPCallLog"("userId", "ts");

-- Rename existing FK to match Prisma's new naming convention for nullable FKs
ALTER TABLE "MCPCallLog" RENAME CONSTRAINT "MCPCallLog_link_fkey" TO "MCPCallLog_linkId_fkey";

ALTER TABLE "MCPCallLog" ADD CONSTRAINT "MCPCallLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
