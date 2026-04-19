#!/usr/bin/env bash
# Vercel "Ignored Build Step" gate for schema-validate GH Actions workflow.
#
# Wired via Vercel Project Settings → Git → Ignored Build Step:
#   bash scripts/vercel-ignore-build.sh
#
# Vercel convention: exit 0 = SKIP the build; exit 1 = PROCEED with the build.
#
# Logic:
#   - If this commit doesn't touch prisma/** → proceed (workflow wasn't triggered).
#   - Otherwise, look up the schema-validate.yml workflow run for this SHA:
#       • completed + success  → proceed
#       • completed + failure  → skip (block the deploy, loudly)
#       • in-progress / queued → poll up to ~4 minutes, then skip (fail-safe)
#       • no run found         → poll briefly (race with webhook), then proceed
#
# Required env (set in Vercel Project Settings → Environment Variables):
#   GH_REPO   — "owner/repo", e.g. "jsa7cornell/agentenvoy"
#   GH_TOKEN  — fine-grained PAT with Actions: read on this repo
#
# Rationale: schema-drift-recurrence proposal (2026-04-20), Option E.
# Track A' (schema-validate.yml) was PR-gated; bcf2ec1 bypassed it via a
# direct push to main and broke create_link in prod. This script makes the
# workflow's verdict blocking for every main deploy, not just PR merges.

set -euo pipefail

SHA="${VERCEL_GIT_COMMIT_SHA:-}"
if [ -z "$SHA" ]; then
  echo "[ignore-build] VERCEL_GIT_COMMIT_SHA not set — proceeding (non-git build)."
  exit 1
fi

# Schema-touching commit? If not, schema-validate didn't run; nothing to gate on.
# We inspect the commit's file list via GitHub's commit API (no git history
# needed in the Vercel build sandbox).
if [ -z "${GH_REPO:-}" ] || [ -z "${GH_TOKEN:-}" ]; then
  echo "[ignore-build] GH_REPO / GH_TOKEN not set — cannot gate. Proceeding (fail-open)."
  echo "[ignore-build] Set these in Vercel env to enable the schema-validate gate."
  exit 1
fi

api() {
  curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

echo "[ignore-build] commit=$SHA repo=$GH_REPO"

COMMIT_JSON=$(api "https://api.github.com/repos/$GH_REPO/commits/$SHA" 2>/dev/null || echo "")
if [ -z "$COMMIT_JSON" ]; then
  echo "[ignore-build] Commit lookup failed — proceeding (fail-open)."
  exit 1
fi

TOUCHES_PRISMA=$(
  printf '%s' "$COMMIT_JSON" \
    | grep -oE '"filename": *"prisma/(schema\.prisma|migrations/[^"]+)"' \
    | head -n1 || true
)

if [ -z "$TOUCHES_PRISMA" ]; then
  echo "[ignore-build] Commit does not touch prisma/** — schema-validate not applicable. Proceeding."
  exit 1
fi

echo "[ignore-build] Commit touches prisma/** — checking schema-validate.yml status..."

# Poll for the workflow run. GitHub typically dispatches within seconds of
# the push webhook, but Vercel can race it. We poll for up to ~4 minutes.
WORKFLOW_FILE="schema-validate.yml"
DEADLINE=$((SECONDS + 240))

while [ $SECONDS -lt $DEADLINE ]; do
  RUNS_JSON=$(api "https://api.github.com/repos/$GH_REPO/actions/workflows/$WORKFLOW_FILE/runs?head_sha=$SHA&per_page=1" 2>/dev/null || echo "")
  STATUS=$(printf '%s' "$RUNS_JSON" | grep -m1 -oE '"status": *"[^"]+"' | head -n1 | sed 's/.*"\([^"]*\)"$/\1/' || true)
  CONCLUSION=$(printf '%s' "$RUNS_JSON" | grep -m1 -oE '"conclusion": *"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)"$/\1/' || true)

  if [ -z "$STATUS" ]; then
    echo "[ignore-build] No workflow run for $SHA yet (waiting for dispatch)..."
  else
    echo "[ignore-build] status=$STATUS conclusion=${CONCLUSION:-<none>}"
    if [ "$STATUS" = "completed" ]; then
      case "$CONCLUSION" in
        success)
          echo "[ignore-build] ✓ schema-validate passed — proceeding with deploy."
          exit 1
          ;;
        "")
          echo "[ignore-build] Completed without conclusion — treating as failure."
          exit 0
          ;;
        *)
          echo "[ignore-build] ✗ schema-validate conclusion=$CONCLUSION — BLOCKING deploy."
          exit 0
          ;;
      esac
    fi
  fi
  sleep 15
done

echo "[ignore-build] Timed out waiting for schema-validate (>4 min). Blocking deploy to be safe."
echo "[ignore-build] Rerun the deploy after the workflow completes, or investigate a stuck runner."
exit 0
