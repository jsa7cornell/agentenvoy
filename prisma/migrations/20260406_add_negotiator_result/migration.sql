-- CreateTable
CREATE TABLE "NegotiatorResult" (
    "id" TEXT NOT NULL,
    "shareCode" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "agents" JSONB NOT NULL,
    "research" JSONB NOT NULL,
    "syntheses" JSONB NOT NULL,
    "humanDecisions" JSONB NOT NULL DEFAULT '[]',
    "hostClarifications" JSONB NOT NULL DEFAULT '[]',
    "finalResponses" JSONB NOT NULL DEFAULT '[]',
    "adminSummary" TEXT,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "transcript" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NegotiatorResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NegotiatorResult_shareCode_key" ON "NegotiatorResult"("shareCode");
