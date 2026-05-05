-- CreateTable
CREATE TABLE "ComposerReport" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "messageContent" TEXT NOT NULL,
    "adminNote" TEXT,
    "url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "actionTaken" TEXT,
    "bundle" JSONB NOT NULL,

    CONSTRAINT "ComposerReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComposerReport_createdAt_idx" ON "ComposerReport"("createdAt");

-- CreateIndex
CREATE INDEX "ComposerReport_status_createdAt_idx" ON "ComposerReport"("status","createdAt");

-- CreateIndex
CREATE INDEX "ComposerReport_userId_idx" ON "ComposerReport"("userId");

-- AddForeignKey
ALTER TABLE "ComposerReport" ADD CONSTRAINT "ComposerReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
