#!/bin/bash
# Check latest Vercel deployment status via GitHub API
set -e
export PATH="/opt/homebrew/bin:$PATH"

echo "Checking latest deployment status..."
gh api repos/jsa7cornell/agentenvoy/deployments --jq '.[0] | "Deploy: \(.sha[0:7]) | Status: \(.statuses_url | split("/") | last) | Env: \(.environment) | Created: \(.created_at)"' 2>/dev/null || echo "Could not fetch deploy status. Check https://vercel.com/dashboard"
