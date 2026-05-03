-- CalendarListCache: per-user TTL'd cache of Google's calendar list.
-- Eliminates the unconditional client.calendarList.list() round-trip on every
-- syncCalendar invocation. See proposal 2026-05-02_picker-load-perf.

CREATE TABLE "CalendarListCache" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "calendars" JSONB NOT NULL DEFAULT '[]',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarListCache_pkey" PRIMARY KEY ("id")
);

-- userId is the only access pattern — enforce uniqueness and index it.
CREATE UNIQUE INDEX "CalendarListCache_userId_key" ON "CalendarListCache"("userId");

-- Cascade delete when the user is removed.
ALTER TABLE "CalendarListCache" ADD CONSTRAINT "CalendarListCache_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
