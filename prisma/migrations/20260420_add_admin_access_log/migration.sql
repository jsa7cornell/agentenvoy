-- F5: AdminAccessLog — break-glass audit of admin reads of user data.
-- Additive: new table only, no changes to existing tables.

CREATE TABLE "AdminAccessLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "path" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "contextJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAccessLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAccessLog_adminId_createdAt_idx" ON "AdminAccessLog"("adminId", "createdAt");
CREATE INDEX "AdminAccessLog_targetUserId_createdAt_idx" ON "AdminAccessLog"("targetUserId", "createdAt");
CREATE INDEX "AdminAccessLog_createdAt_idx" ON "AdminAccessLog"("createdAt");

ALTER TABLE "AdminAccessLog" ADD CONSTRAINT "AdminAccessLog_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
