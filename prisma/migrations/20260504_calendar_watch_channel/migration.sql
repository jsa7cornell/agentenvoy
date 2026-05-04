-- CreateTable: CalendarWatchChannel
-- Registry of active Google Calendar push-notification channels
-- (events.watch + calendarList.watch). Stores the per-channel random token
-- that Google echoes in X-Goog-Channel-Token so the webhook handler can
-- authenticate each ping without a shared secret.

CREATE TABLE "CalendarWatchChannel" (
    "id"             TEXT NOT NULL,
    "channelId"      TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "calendarId"     TEXT,
    "resourceId"     TEXT NOT NULL,
    "token"          TEXT NOT NULL,
    "kind"           TEXT NOT NULL,
    "expiration"     TIMESTAMP(3) NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPingAt"     TIMESTAMP(3),
    "lastSyncDiffAt" TIMESTAMP(3),
    "active"         BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CalendarWatchChannel_pkey" PRIMARY KEY ("id")
);

-- Standard indexes
CREATE UNIQUE INDEX "CalendarWatchChannel_channelId_key" ON "CalendarWatchChannel"("channelId");
CREATE INDEX "CalendarWatchChannel_userId_idx" ON "CalendarWatchChannel"("userId");
CREATE INDEX "CalendarWatchChannel_expiration_idx" ON "CalendarWatchChannel"("expiration");
CREATE INDEX "CalendarWatchChannel_active_idx" ON "CalendarWatchChannel"("active");

-- Two partial unique indexes work together to enforce idempotency on
-- CalendarWatchChannel. DO NOT DROP EITHER. They cover disjoint cases:
--
--   Index 1 covers kind = 'events' (calendarId IS NOT NULL):
--     a single user can have at most one ACTIVE 'events' channel
--     per (calendarId).
--
--   Index 2 covers kind = 'calendarList' (calendarId IS NULL):
--     a single user can have at most one ACTIVE 'calendarList' channel.
--
-- Why both: Postgres treats NULLs as DISTINCT in unique constraints by
-- default. Index 1's (userId, calendarId, kind) cannot enforce uniqueness
-- when calendarId IS NULL — without index 2, a user could end up with
-- multiple ACTIVE calendarList channels racing pings against the same
-- handler. Index 2 closes that gap by keying only on (userId, kind) and
-- filtering on kind = 'calendarList'.
--
-- The application-layer idempotency check in registerEventsWatch /
-- registerCalendarListWatch is the happy path; these indexes are the
-- safety net under concurrent OAuth-callback / settings-change races.

CREATE UNIQUE INDEX "CalendarWatchChannel_user_calendar_kind_active"
  ON "CalendarWatchChannel" ("userId", "calendarId", "kind")
  WHERE "active" = true;

CREATE UNIQUE INDEX "CalendarWatchChannel_user_calendarList_active"
  ON "CalendarWatchChannel" ("userId", "kind")
  WHERE "kind" = 'calendarList' AND "active" = true;

-- Foreign key
ALTER TABLE "CalendarWatchChannel"
  ADD CONSTRAINT "CalendarWatchChannel_userId_fkey"
  FOREIGN KEY ("userId")
  REFERENCES "User"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
