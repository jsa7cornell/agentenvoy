# DB Restore Runbook

> **When you need this:** production data loss (accidental TRUNCATE/DELETE/DROP, corruption, ransomware-class event), or restoring a recent prod snapshot to a staging Supabase project for debugging.

Backups are produced daily at 02:00 UTC by `.github/workflows/db-backup.yml`
and uploaded to Cloudflare R2 with 30-day retention. Format is Postgres
custom (`.pgdump`), schema=public only, `--no-owner --no-acl` so they restore
cleanly into any Supabase project.

---

## Prereqs

```bash
# Postgres 17 client tools
brew install libpq && brew link --force libpq

# AWS CLI (R2 is S3-compatible)
brew install awscli
```

You'll need the four R2 values that match the GitHub Actions secrets. Store
them in 1Password if not already there. **Do not put them in `.env.local`.**

```bash
export AWS_ACCESS_KEY_ID="..."          # R2_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY="..."      # R2_SECRET_ACCESS_KEY
export AWS_DEFAULT_REGION=auto
export R2_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
export R2_BUCKET="agentenvoy-backups"
```

Recommended: use `op run` so the values come from 1Password and never sit in
your shell history.

---

## 1. List available backups

```bash
aws s3 ls "s3://$R2_BUCKET/" --endpoint-url "$R2_ENDPOINT"
```

Output looks like `backup-2026-05-04T02-00-00Z.pgdump` (full UTC timestamp).
Pick the most recent one *before* the incident — not after, or you'll restore
the wiped state.

## 2. Download

```bash
aws s3 cp "s3://$R2_BUCKET/backup-2026-05-03T02-00-00Z.pgdump" ./restore.pgdump \
  --endpoint-url "$R2_ENDPOINT"

# Sanity-check before restoring
pg_restore --list ./restore.pgdump | head -30
```

## 3. Pick a target DB

**Restore in place (data-loss recovery, prod):**
- Source URL: the existing Supabase project's `POSTGRES_URL_NON_POOLING`.
- Risk: destructive. The restore will fail loudly if tables exist with data;
  use `--clean --if-exists` only when you're certain you want to drop and
  recreate every table in `public`.

**Restore to a fresh Supabase project (preferred for safety):**
1. Create a new Supabase project.
2. Grab its `Direct connection` URL (Settings → Database → Connection string
   → "URI", direct/non-pooled).
3. Restore into the empty project.
4. Once verified, swap the app's env vars to point at the new project.

## 4. Restore

```bash
# Replace with the target project's direct (non-pooled) URL
TARGET_URL="postgresql://postgres.<project-ref>:<password>@<host>:5432/postgres"

pg_restore \
  --no-owner \
  --no-acl \
  --schema=public \
  --dbname="$TARGET_URL" \
  ./restore.pgdump
```

For an in-place restore over existing tables, add `--clean --if-exists` —
this drops each public-schema object before recreating it. Only do this when
you've already confirmed there is no salvageable data in the target.

The Supabase-managed schemas (`auth`, `storage`, `realtime`) are not in the
dump. They are recreated automatically by Supabase when the project is
provisioned, so a fresh project starts with them intact.

## 5. Verify

```bash
psql "$TARGET_URL" -c '\dt public.*'
psql "$TARGET_URL" -c 'SELECT count(*) FROM "Account";'
psql "$TARGET_URL" -c 'SELECT count(*) FROM "ChannelMessage";'
```

Cross-check counts against expectations. Then run the app against the new DB
in dev (`POSTGRES_PRISMA_URL` and `POSTGRES_URL_NON_POOLING` both updated)
and exercise the golden paths before swapping prod.

## 6. Post-restore — reaching a working app

A restored DB is necessary but **not sufficient** for a working AgentEnvoy.
A `pg_restore` produces Postgres rows; it does not produce a running app.
Walk through this list in order — the early items unblock the later ones.

### 6.1 Connection strings

- [ ] **Vercel** — update `POSTGRES_PRISMA_URL` and `POSTGRES_URL_NON_POOLING`
      env vars (Production, Preview, Development as appropriate) to the new
      project's pooled / direct URLs.
- [ ] **1Password** — update `POSTGRES_URL_NON_POOLING` in the Secrets vault.
- [ ] **GitHub Actions** — update the `BACKUP_POSTGRES_URL` repository secret
      so future backups point at the new project, not the dead one.

### 6.2 Auth

- [ ] **`NEXTAUTH_SECRET`** — keep unchanged if possible. Rotating it
      invalidates every active session and forces a global re-login. If the
      secret was leaked or unrecoverable, rotation is unavoidable; document it.
- [ ] **`NEXTAUTH_URL`** — must match the live Vercel domain.
- [ ] **Google OAuth client** — `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
      are unchanged, but the **redirect URI** in Google Cloud Console must
      include the live domain. If the project domain hasn't changed, no action.
- [ ] **Encryption key for refresh tokens.** `Account.refresh_token` is
      encrypted at rest with the app's encryption key. If that key has not
      rotated, tokens decrypt and Google access continues. **If the key has
      rotated or been lost, refresh tokens are unrecoverable** — every user
      must re-authenticate with Google.

### 6.3 Provider keys

- [ ] **Anthropic API key** (`ANTHROPIC_API_KEY`)
- [ ] **Langfuse keys** if observability was enabled
- [ ] Any MCP server credentials referenced in `.env.example` that the app
      reads at runtime

### 6.4 Calendar push channels

`CalendarWatchChannel` rows are restored with the rest of `public`, but the
*actual Google-side channels* they reference are tied to a Google `channelId`
and the original webhook URL. After a restore, those channels are stale.

- [ ] If the live domain is unchanged: stale channels expire on Google's side
      within 7 days. Cron phase 8/9/10 reconciles. Most users will get a
      fresh channel on next sign-in via `reconcileEventsWatches`.
- [ ] If the live domain changed: explicitly run `stopAllWatchesForUser` for
      all users (or accept the 7-day expiry), then trigger `registerEventsWatch`
      via the cron's reconciliation phase or by user activity.
- [ ] Either way, monitor the admin calendar-health endpoint
      (`/api/admin/calendar-health/[userId]`) for "dead" channels in the
      first 24h.

### 6.5 Verification before declaring success

- [ ] One golden-path flow exercised end-to-end: sign in with Google, view
      the home page, propose a slot via a Negotiation link, the proposal is
      persisted, accept the proposal, the event lands on Google Calendar.
- [ ] `LOG.md` updated with: backup file used, restore start/end times,
      data window lost (between dump time and incident), and any users known
      to have been forced to re-authenticate.

---

## Restore drills

> **A backup that has never been restored is not a backup.**

This system commits to:

1. **One-time end-to-end drill** within 7 days of the backup workflow first
   running successfully. Restore the most recent dump into a throwaway
   Supabase project, run the app against it locally, exercise §6.5's
   golden-path flow. Record outcome in `LOG.md`. If the drill fails, the
   failure is the next blocker before the system is considered "in production."
2. **Quarterly drills thereafter.** Same flow, lighter scope. Recorded in
   `LOG.md`. Calendar reminder lives with John.

The drill is **not** "fire `workflow_dispatch` and confirm a `.pgdump` shows
up in R2." That proves the dump path; restore is the only path that matters.

---

## Notes

- **Recovery point objective:** up to 24 hours of data loss is possible
  (daily cadence). Anything written between 02:00 UTC and the incident is
  not in the dump.
- **Recovery time objective:** ~10–30 minutes for download + restore on a
  small DB. Scales with dump size.
- The dump excludes Supabase internal schemas, so you cannot restore auth
  users from a `pg_dump` of `public` alone. Auth users live in the `auth`
  schema and are managed separately by Supabase. For an auth-loss scenario,
  contact Supabase support — `pg_dump` is not the right tool there.
