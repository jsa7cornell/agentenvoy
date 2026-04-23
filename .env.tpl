# ─── Supabase ──────────────────────────────────────────────
NEXT_PUBLIC_SUPABASE_URL=op://Secrets/NEXT_PUBLIC_SUPABASE_URL/credential
NEXT_PUBLIC_SUPABASE_ANON_KEY=op://Secrets/NEXT_PUBLIC_SUPABASE_ANON_KEY/credential

# ─── Prisma ────────────────────────────────────────────────
POSTGRES_PRISMA_URL=op://Secrets/POSTGRES_PRISMA_URL/credential
POSTGRES_URL_NON_POOLING=op://Secrets/POSTGRES_URL_NON_POOLING/credential

# ─── NextAuth ──────────────────────────────────────────────
NEXTAUTH_URL=op://Secrets/NEXTAUTH_URL/credential
NEXTAUTH_SECRET=op://Secrets/NEXTAUTH_SECRET/credential

# ─── Google OAuth ──────────────────────────────────────────
GOOGLE_CLIENT_ID=op://Secrets/GOOGLE_CLIENT_ID/credential
GOOGLE_CLIENT_SECRET=op://Secrets/GOOGLE_CLIENT_SECRET/credential

# ─── Vercel AI Gateway ─────────────────────────────────────
# Auth for local dev. Production uses OIDC automatically (no key needed).
# BYOK provider keys (Anthropic/Google/OpenAI) are configured in Vercel dashboard.
AI_GATEWAY_API_KEY=op://Secrets/AI_GATEWAY_API_KEY/credential

# ─── Direct Anthropic (bench only) ────────────────────────
# Used when BENCH_DIRECT=1 to bypass Vercel AI Gateway for bench runs.
# Not used by the production app.
ANTHROPIC_API_KEY=op://Secrets/ANTHROPIC_API_KEY/credential

# ─── Email (AWS SES) ───────────────────────────────────────
AWS_SES_ACCESS_KEY_ID=op://Private/AWS Access Key/access key id
AWS_SES_SECRET_ACCESS_KEY=op://Private/AWS Access Key/secret access key
AWS_SES_REGION=us-west-2

# ─── Side-effect dispatcher ────────────────────────────────
# Per-kind mode: live | allowlist | log | dryrun | off.
# Local dev defaults to `log` — no real email, everything recorded to SideEffectLog.
# Vercel sets preview=log, production=live. See RISK-MANAGEMENT.md.
EFFECT_MODE_EMAIL=log
# Comma-separated domains allowed when EFFECT_MODE_EMAIL=allowlist.
EFFECT_ALLOW_EMAIL_DOMAINS=agentenvoy.dev

# Calendar: local/preview default to `dryrun` so the confirm flow gets a fake
# meetLink + eventId and keeps working end-to-end without creating real events.
# Production uses `live`. Covers create_event / create_hold / delete_event.
EFFECT_MODE_CALENDAR=dryrun
# Safety belt: when EFFECT_MODE_CALENDAR=live, this controls whether invitees
# get real email notifications. Default `all` matches historical behavior in
# production. Set to `none` on preview IF you ever flip it to live there.
CALENDAR_SEND_UPDATES=all

# ─── Admin smoke token ─────────────────────────────────────
# Token for /api/admin/smoke — also stored in Vercel prod env + GitHub Actions secret.
ADMIN_SMOKE_TOKEN=op://Secrets/ADMIN_SMOKE_TOKEN/credential

# ─── Agent-accessible feedback pipeline (2026-04-21) ──────
# HS256 JWT signing key for per-report short-lived agent tokens. 15-min TTL,
# 10-fetch cap. Mint from /admin/feedback/:id. See PLAYBOOK "Debug bundle
# handling" and proposals/2026-04-21_agent-accessible-feedback-pipeline §6.2.
# Rotation: put the outgoing secret in AGENT_TOKEN_SECRET_PREVIOUS for 15 min.
AGENT_TOKEN_SECRET=op://Secrets/AGENT_TOKEN_SECRET/credential
# AGENT_TOKEN_SECRET_PREVIOUS= (unset by default; set only during rotation)

# Prompt-snapshot capture on the incident turn (T2a). Default ON; set "false"
# to disable capture at write-time (does not affect already-stored snapshots).
# PROMPT_SNAPSHOT_ENABLED=true

# ─── Dev Auth (non-secret, dev-only) ──────────────────────
DEV_AUTH_SECRET=dev-test-secret-local-only
NEXT_PUBLIC_DEV_AUTH_SECRET=dev-test-secret-local-only
