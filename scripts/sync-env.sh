#!/bin/bash
# Generates .env.local from 1Password references in .env.tpl
# Run this once per machine (or after adding new secrets to .env.tpl)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

if ! command -v op &> /dev/null; then
  echo "ERROR: 1Password CLI (op) not found. Install it first."
  exit 1
fi

op inject -i "$APP_DIR/.env.tpl" -o "$APP_DIR/.env.local"
echo ".env.local synced from 1Password ($(date))"
