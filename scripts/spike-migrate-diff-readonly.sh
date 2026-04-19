#!/usr/bin/env bash
# Option B verification spike (schema-drift-recurrence proposal, 2026-04-20).
#
# Goal: confirm `prisma migrate diff --exit-code` is truly read-only against
# a Supabase role with SELECT-only grants. If yes, we can add it to the
# pre-push hook as a belt-and-suspenders check on top of Option E.
#
# Prerequisites (John runs these once in Supabase SQL Editor):
#
#   -- Create a read-only role with SELECT only
#   CREATE ROLE prisma_ro WITH LOGIN PASSWORD '<pick-one>';
#   GRANT CONNECT ON DATABASE postgres TO prisma_ro;
#   GRANT USAGE ON SCHEMA public TO prisma_ro;
#   GRANT SELECT ON ALL TABLES IN SCHEMA public TO prisma_ro;
#   ALTER DEFAULT PRIVILEGES IN SCHEMA public
#     GRANT SELECT ON TABLES TO prisma_ro;
#
# Then store a connection string in 1Password as "agentenvoy-prisma-ro"
# with field "url" = postgresql://prisma_ro:<pw>@<direct-host>:5432/postgres
#
# Run this spike with:
#   cd app && bash scripts/spike-migrate-diff-readonly.sh
#
# Success = exit 0 or 2 (2 = drift detected, which is fine for the test —
# it means the command DID something without needing write access).
# Failure = any Prisma error about "shadow database" or "CREATE DATABASE"
# permission — in which case the mechanism doesn't work and we stick with
# Option E alone.

set -u

URL=$(op read "op://Secrets/agentenvoy-prisma-ro/url" 2>/dev/null || true)
if [ -z "$URL" ]; then
  echo "ERROR: couldn't read agentenvoy-prisma-ro from 1Password."
  echo "Create the read-only role (see header comment), then store the"
  echo "connection string as 1Password item 'agentenvoy-prisma-ro' with field 'url'."
  exit 3
fi

echo "[spike] Testing: migrate diff from schema.prisma → read-only URL"
echo "[spike] Exit codes: 0 = in sync, 2 = drift detected, other = tool error"
echo ""

npx prisma migrate diff \
  --from-schema-datamodel prisma/schema.prisma \
  --to-url "$URL" \
  --exit-code
RC=$?

echo ""
echo "[spike] exit code: $RC"
case $RC in
  0)
    echo "[spike] ✓ Success — schema.prisma matches DB (no drift)."
    echo "[spike] Mechanism works with read-only role. SAFE to add to pre-push hook."
    ;;
  2)
    echo "[spike] ✓ Success — drift detected but command ran cleanly without write access."
    echo "[spike] Mechanism works with read-only role. SAFE to add to pre-push hook."
    ;;
  *)
    echo "[spike] ✗ Failed. Check error above. If it mentions shadow DB / CREATE DATABASE,"
    echo "[spike] the mechanism doesn't work read-only and Option B is NOT safe as proposed."
    echo "[spike] In that case: stick with Option E (GH Actions + Vercel Ignored Build Step)"
    echo "[spike] alone. Document the negative result in LOG.md."
    ;;
esac

exit $RC
