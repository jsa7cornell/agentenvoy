-- CreateTable: GroupCoordination
CREATE TABLE "GroupCoordination" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "responses" JSONB NOT NULL DEFAULT '[]',
    "synthesisVersion" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'gathering',
    "suggestionsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupCoordination_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ActivitySuggestion
CREATE TABLE "ActivitySuggestion" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "person" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivitySuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupCoordination_sessionId_key" ON "GroupCoordination"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ActivitySuggestion_sessionId_normalizedValue_category_key" ON "ActivitySuggestion"("sessionId", "normalizedValue", "category");

-- CreateIndex
CREATE INDEX "ActivitySuggestion_sessionId_idx" ON "ActivitySuggestion"("sessionId");

-- AddForeignKey
ALTER TABLE "GroupCoordination" ADD CONSTRAINT "GroupCoordination_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NegotiationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySuggestion" ADD CONSTRAINT "ActivitySuggestion_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NegotiationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
