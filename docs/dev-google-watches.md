# Google Calendar Push Notifications — Dev Runbook

Proposal: `proposals/2026-05-04_google-calendar-push-notifications_reviewed-2026-05-04.md`

## How it works

Google sends a POST to `/api/webhooks/google-calendar` whenever a calendar changes.
The handler records `lastPingAt`, runs `incrementalSyncForUser`, and sets `lastSyncDiffAt`
if changes were found. Belt-and-suspenders: the 5-min polling cron still runs as a backstop.

## Dev/preview — disable watch registration

Set `GOOGLE_WATCH_DISABLED=1` to skip all watch registration and silence the webhook handler.
This is the default in `vercel.json` for preview environments. Polling continues unaffected.

## Local development with real pings (optional)

1. Install ngrok: `brew install ngrok`
2. Start the dev server: `pnpm dev` (port 3000)
3. Expose it: `ngrok http 3000`
4. Set `PUBLIC_BASE_URL` to the ngrok HTTPS URL in `.env.local`
5. Remove or unset `GOOGLE_WATCH_DISABLED` in `.env.local`
6. Sign in with a Google account — `registerEventsWatch` fires on sign-in
7. Make a calendar change in Google Calendar — you should see a POST hit the handler

**Note:** channels expire in ~7 days. Renewal is handled by the daily cron (Phase 8).

## Testing the webhook handler without ngrok

Use the admin health endpoint's synthetic ping:

```
POST /api/admin/calendar-health/[userId]?action=test-ping
{ "calendarId": "primary", "kind": "events" }
```

This calls `incrementalSyncForUser` directly and returns `{ foundChanges: bool }`.
Token validation is bypassed in non-production.

## Admin health endpoint

```
GET /api/admin/calendar-health/[userId]
```

Returns:
- `channels[]` — each channel with `health: "healthy" | "stale" | "expiring" | "dead"`
- `cache.calendarListAgeMs` — age of calendar list cache
- `cache.eventsLastSyncedAtPerCal` — per-calendar cache age in ms
- `pings.last10` — 10 most recent pings with `foundChanges` flag
- `pings.last24hCount` — ping count in last 24h

## Cron phases

| Phase | What it does | Key threshold |
|-------|-------------|---------------|
| 8 | Renew expiring channels | events < 48h, calendarList < 96h |
| 9 | Stop and mark dead stale channels | no ping in 7d |
| 10 | Watchdog: sync users with recent activity but no recent diff | 24h window |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `GOOGLE_WATCH_DISABLED` | Set to `1` to disable all watch registration + handling |
| `PUBLIC_BASE_URL` | Base URL passed to Google as the webhook address |

## Schema

`CalendarWatchChannel` table tracks active channels:
- `channelId` — Google's channel ID
- `kind` — `"events"` or `"calendarList"`
- `token` — HMAC secret for request validation (32 bytes hex)
- `active` — false after stop/expiry/dead-token
- `lastPingAt` — updated on every valid ping
- `lastSyncDiffAt` — updated only when `incrementalSyncForUser` returns `true`

## Dead-token handling

If `incrementalSyncForUser` throws and `isDeadGoogleAuthError` returns true:
1. `clearGoogleRefreshToken(userId)` — removes the token from the DB
2. `stopAllWatchesForUser(userId)` — marks all channels inactive (best-effort)

Order matters: clear token first so stop calls can't re-authenticate and re-register.
