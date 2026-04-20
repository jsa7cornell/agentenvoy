-- Baseline — full schema as of 2026-04-20 (after F1 userClass).
--
-- Why a baseline: the 15 migrations that used to live here (2026-04-06
-- through 2026-04-21) described deltas against a pre-April schema that
-- was built via direct Supabase SQL Editor, never captured in migration
-- files. On a fresh DB, those deltas failed because the tables they
-- ALTER'd (NegotiationSession, NegotiationLink, User) didn't exist yet.
--
-- The schema-validate CI job was failing on every run for exactly this
-- reason (relation "NegotiationSession" does not exist, P3018). Flattening
-- to one baseline makes fresh-DB validation reproducible, aligns with
-- Track A of the schema-management-and-deploy-infra proposal (one
-- _prisma_migrations row to bootstrap, not 15), and gives future
-- migrations a clean foundation.
--
-- Prod is unaffected: Vercel does not run `prisma migrate deploy` yet
-- (Track A not shipped), and prod's actual DB state already matches
-- this baseline. When Track A lands, bootstrap inserts one applied
-- row for this migration and future migrations go on top.

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "meetSlug" TEXT,
    "preferences" JSONB DEFAULT '{}',
    "hostDirectives" JSONB DEFAULT '[]',
    "persistentKnowledge" TEXT,
    "situationalKnowledge" TEXT,
    "lastCalibratedAt" TIMESTAMP(3),
    "onboardingPhase" TEXT,
    "userClass" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NegotiationLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'generic',
    "mode" TEXT NOT NULL DEFAULT 'single',
    "slug" TEXT NOT NULL,
    "code" TEXT,
    "inviteeEmail" TEXT,
    "inviteeName" TEXT,
    "inviteeTimezone" TEXT,
    "hostNote" VARCHAR(280),
    "topic" TEXT,
    "rules" JSONB DEFAULT '{}',
    "sourceRuleId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "hashSalt" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NegotiationLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NegotiationSession" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "guestId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'calendar',
    "status" TEXT NOT NULL DEFAULT 'active',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT,
    "statusLabel" TEXT,
    "meetingType" TEXT,
    "duration" INTEGER,
    "format" TEXT,
    "agreedTime" TIMESTAMP(3),
    "agreedFormat" TEXT,
    "summary" TEXT,
    "meetLink" TEXT,
    "calendarEventId" TEXT,
    "guestEmail" TEXT,
    "guestName" TEXT,
    "guestTimezone" TEXT,
    "wantsReminder" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NegotiationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT,
    "dateTime" TIMESTAMP(3),
    "duration" INTEGER,
    "format" TEXT,
    "location" TEXT,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'offered',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NegotiationOutcome" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "exchangeCount" INTEGER NOT NULL,
    "tierReached" INTEGER NOT NULL DEFAULT 1,
    "guestCounterProposed" BOOLEAN NOT NULL DEFAULT false,
    "timeToConfirmationSec" INTEGER,
    "proposedFormat" TEXT,
    "agreedFormat" TEXT,
    "participantCount" INTEGER NOT NULL DEFAULT 2,
    "feedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NegotiationOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionParticipant" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'guest',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMessage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "threadId" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarCache" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "calendarName" TEXT NOT NULL,
    "syncToken" TEXT,
    "events" JSONB NOT NULL DEFAULT '[]',
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComputedSchedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slots" JSONB NOT NULL DEFAULT '[]',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inputHash" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ComputedSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelSession" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "summary" TEXT,
    "closed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ChannelSession_pkey" PRIMARY KEY ("id")
);

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
    "usageRows" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NegotiatorResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hold" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "slotStart" TIMESTAMP(3) NOT NULL,
    "slotEnd" TIMESTAMP(3) NOT NULL,
    "calendarEventId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SideEffectLog" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "targetSummary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "contextJson" JSONB,
    "providerRef" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SideEffectLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfirmAttempt" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "slotStart" TIMESTAMP(3),
    "slotEnd" TIMESTAMP(3),
    "outcome" TEXT NOT NULL,
    "errorMessage" TEXT,
    "userAgent" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfirmAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteError" (
    "id" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "method" TEXT,
    "statusCode" INTEGER,
    "errorClass" TEXT,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "contextJson" JSONB,
    "userId" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouteError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCPRateCounter" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MCPRateCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRequest" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "sessionId" TEXT,
    "field" TEXT NOT NULL,
    "appliedValue" JSONB NOT NULL,
    "rationaleTemplate" TEXT,
    "rationaleProse" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCPCallLog" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkId" TEXT NOT NULL,
    "sessionId" TEXT,
    "tool" TEXT NOT NULL,
    "clientName" TEXT,
    "clientType" TEXT,
    "principal" JSONB,
    "requestBody" JSONB NOT NULL,
    "responseBody" JSONB NOT NULL,
    "outcome" TEXT NOT NULL,
    "latencyMs" INTEGER,

    CONSTRAINT "MCPCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_meetSlug_key" ON "User"("meetSlug");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_key_key" ON "ApiKey"("key");

-- CreateIndex
CREATE INDEX "ApiKey_key_idx" ON "ApiKey"("key");

-- CreateIndex
CREATE UNIQUE INDEX "NegotiationLink_code_key" ON "NegotiationLink"("code");

-- CreateIndex
CREATE INDEX "NegotiationLink_slug_idx" ON "NegotiationLink"("slug");

-- CreateIndex
CREATE INDEX "NegotiationLink_slug_code_idx" ON "NegotiationLink"("slug", "code");

-- CreateIndex
CREATE UNIQUE INDEX "NegotiationOutcome_sessionId_key" ON "NegotiationOutcome"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_userId_key" ON "Channel"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionParticipant_sessionId_key" ON "SessionParticipant"("sessionId");

-- CreateIndex
CREATE INDEX "SessionParticipant_linkId_idx" ON "SessionParticipant"("linkId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionParticipant_linkId_email_key" ON "SessionParticipant"("linkId", "email");

-- CreateIndex
CREATE INDEX "ChannelMessage_channelId_idx" ON "ChannelMessage"("channelId");

-- CreateIndex
CREATE INDEX "ChannelMessage_threadId_idx" ON "ChannelMessage"("threadId");

-- CreateIndex
CREATE INDEX "CalendarCache_userId_idx" ON "CalendarCache"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarCache_userId_calendarId_key" ON "CalendarCache"("userId", "calendarId");

-- CreateIndex
CREATE UNIQUE INDEX "ComputedSchedule_userId_key" ON "ComputedSchedule"("userId");

-- CreateIndex
CREATE INDEX "ChannelSession_channelId_idx" ON "ChannelSession"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "NegotiatorResult_shareCode_key" ON "NegotiatorResult"("shareCode");

-- CreateIndex
CREATE INDEX "Hold_sessionId_idx" ON "Hold"("sessionId");

-- CreateIndex
CREATE INDEX "Hold_hostId_idx" ON "Hold"("hostId");

-- CreateIndex
CREATE INDEX "Hold_status_expiresAt_idx" ON "Hold"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "SideEffectLog_kind_createdAt_idx" ON "SideEffectLog"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "SideEffectLog_status_createdAt_idx" ON "SideEffectLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ConfirmAttempt_sessionId_createdAt_idx" ON "ConfirmAttempt"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ConfirmAttempt_outcome_createdAt_idx" ON "ConfirmAttempt"("outcome", "createdAt");

-- CreateIndex
CREATE INDEX "RouteError_route_createdAt_idx" ON "RouteError"("route", "createdAt");

-- CreateIndex
CREATE INDEX "RouteError_createdAt_idx" ON "RouteError"("createdAt");

-- CreateIndex
CREATE INDEX "MCPRateCounter_expiresAt_idx" ON "MCPRateCounter"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MCPRateCounter_tokenHash_tool_windowStart_key" ON "MCPRateCounter"("tokenHash", "tool", "windowStart");

-- CreateIndex
CREATE INDEX "ConsentRequest_linkId_field_status_idx" ON "ConsentRequest"("linkId", "field", "status");

-- CreateIndex
CREATE INDEX "ConsentRequest_sessionId_status_idx" ON "ConsentRequest"("sessionId", "status");

-- CreateIndex
CREATE INDEX "ConsentRequest_expiresAt_idx" ON "ConsentRequest"("expiresAt");

-- CreateIndex
CREATE INDEX "MCPCallLog_linkId_ts_idx" ON "MCPCallLog"("linkId", "ts");

-- CreateIndex
CREATE INDEX "MCPCallLog_sessionId_ts_idx" ON "MCPCallLog"("sessionId", "ts");

-- CreateIndex
CREATE INDEX "MCPCallLog_tool_ts_idx" ON "MCPCallLog"("tool", "ts");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NegotiationLink" ADD CONSTRAINT "NegotiationLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NegotiationSession" ADD CONSTRAINT "NegotiationSession_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "NegotiationLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NegotiationSession" ADD CONSTRAINT "NegotiationSession_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NegotiationSession" ADD CONSTRAINT "NegotiationSession_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NegotiationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NegotiationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NegotiationOutcome" ADD CONSTRAINT "NegotiationOutcome_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NegotiationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionParticipant" ADD CONSTRAINT "SessionParticipant_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "NegotiationLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionParticipant" ADD CONSTRAINT "SessionParticipant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NegotiationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionParticipant" ADD CONSTRAINT "SessionParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "NegotiationSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarCache" ADD CONSTRAINT "CalendarCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputedSchedule" ADD CONSTRAINT "ComputedSchedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelSession" ADD CONSTRAINT "ChannelSession_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hold" ADD CONSTRAINT "Hold_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NegotiationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRequest" ADD CONSTRAINT "ConsentRequest_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "NegotiationLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCPCallLog" ADD CONSTRAINT "MCPCallLog_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "NegotiationLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

