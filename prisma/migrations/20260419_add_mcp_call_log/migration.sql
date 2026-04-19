-- MCPCallLog: append-only audit log of MCP tool invocations.
-- Writes go through src/lib/mcp/call-log.ts redaction (SPEC §7).
-- FK cascades on link deletion — tenant erase removes their log rows.

CREATE TABLE "MCPCallLog" (
  "id"           TEXT PRIMARY KEY,
  "ts"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "linkId"       TEXT NOT NULL,
  "sessionId"    TEXT,
  "tool"         TEXT NOT NULL,
  "clientName"   TEXT,
  "clientType"   TEXT,
  "principal"    JSONB,
  "requestBody"  JSONB NOT NULL,
  "responseBody" JSONB NOT NULL,
  "outcome"      TEXT NOT NULL,
  "latencyMs"    INTEGER,

  CONSTRAINT "MCPCallLog_link_fkey"
    FOREIGN KEY ("linkId") REFERENCES "NegotiationLink"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MCPCallLog_linkId_ts_idx"    ON "MCPCallLog" ("linkId", "ts");
CREATE INDEX "MCPCallLog_sessionId_ts_idx" ON "MCPCallLog" ("sessionId", "ts");
CREATE INDEX "MCPCallLog_tool_ts_idx"      ON "MCPCallLog" ("tool", "ts");
