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

# ─── Email (AWS SES) ───────────────────────────────────────
AWS_SES_ACCESS_KEY_ID=op://Private/AWS Access Key/username
AWS_SES_SECRET_ACCESS_KEY=op://Private/AWS Access Key/credential
AWS_SES_REGION=us-west-2

# ─── Side-effect dispatcher ────────────────────────────────
# Per-kind mode: live | allowlist | log | dryrun | off.
# Local dev defaults to `log` — no real email, everything recorded to SideEffectLog.
# Vercel sets preview=log, production=live. See RISK-MANAGEMENT.md.
EFFECT_MODE_EMAIL=log
# Comma-separated domains allowed when EFFECT_MODE_EMAIL=allowlist.
# Leave empty except during targeted allowlist testing.
EFFECT_ALLOW_EMAIL_DOMAINS=agentenvoy.dev

# ─── Dev Auth (non-secret, dev-only) ──────────────────────
DEV_AUTH_SECRET=dev-test-secret-local-only
NEXT_PUBLIC_DEV_AUTH_SECRET=dev-test-secret-local-only
