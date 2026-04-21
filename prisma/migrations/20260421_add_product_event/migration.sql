-- F2 (revised): ProductEvent — always-on product analytics on Supabase.
-- Replaces the original PostHog proposal with a self-hosted table so we
-- don't take on a third-party vendor before there's a product to protect.
-- Additive: new table only, no changes to existing tables.

CREATE TABLE "ProductEvent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "props" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductEvent_name_createdAt_idx" ON "ProductEvent"("name", "createdAt");
CREATE INDEX "ProductEvent_userId_createdAt_idx" ON "ProductEvent"("userId", "createdAt");
CREATE INDEX "ProductEvent_createdAt_idx" ON "ProductEvent"("createdAt");

ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
