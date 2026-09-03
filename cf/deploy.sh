#!/usr/bin/env bash
#==============================================================================
# deploy.sh — J.A.R.V.I.S. Cloudflare stack deploy & secrets helper.
#
# Usage:
#   bash deploy.sh setup        # create D1, KV, Queue; apply migrations; set secrets
#   bash deploy.sh deploy       # wrangler deploy (after setup)
#   bash deploy.sh migrate      # apply D1 migrations + update webhook URL
#   bash deploy.sh secrets      # (re)set production secrets via wrangler
#   bash deploy.sh webhook      # point Telegram to the deployed worker
#
# Prereqs: wrangler CLI installed & logged in (`wrangler login`), or CLOUDFLARE
# API token in CF_API_TOKEN. This script is a convenience wrapper — the actual
# resource IDs still need to be pasted into wrangler.toml (see setup output).
#==============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

w() { wrangler "$@"; }

wrangler_or_die() { command -v wrangler >/dev/null 2>&1 || { echo "wrangler not found: npm i -g wrangler"; exit 1; }; }

setup() {
  echo "## Creating resources (paste emitted IDs into wrangler.toml)."
  w d1 create jarvis | tee /tmp/jarvis_d1.txt
  w kv namespace create jarvis-config | tee /tmp/jarvis_kv.txt
  # No R2: vault payload stays INLINE in D1 (needs no bucket + no card).
  w queues create jarvis-tasks || true
  w queues create jarvis-tasks-dlq || true
  echo "## Copy the <ID> values above into cf/wrangler.toml placeholders, then run: bash deploy.sh migrate && bash deploy.sh secrets && bash deploy.sh deploy"
}

migrate() {
  w d1 migrations apply jarvis --remote
}

secrets() {
  echo "## Setting production secrets (wrangler secret put)."
  local -A map=( [TELEGRAM_TOKEN]=TELEGRAM_TOKEN [TELEGRAM_SECRET]=TELEGRAM_SECRET [GROQ_API_KEY]=GROQ_API_KEY )
  for var in "${!map[@]}"; do
    echo "---- $var (paste when prompted, or export $var first) ----"
    w secret put "$var" --name jarvis-sovereign
  done
}

deploy_cmd() {
  w deploy
}

webhook() {
  local url="${1:-}"
  if [[ -z "$url" ]]; then
    echo "usage: bash deploy.sh webhook https://jarvis-sovereign.<subdomain>.workers.dev"
    exit 1
  fi
  curl -s -X POST "$url/setwebhook?token=${TELEGRAM_SECRET}&url=${url}/webhook"
  echo
}

wrangler_or_die
cmd="${1:-deploy}"
case "$cmd" in
  setup) setup ;;
  migrate) migrate ;;
  secrets) secrets ;;
  deploy) deploy_cmd ;;
  webhook) webhook "${2:-}" ;;
  *) echo "unknown: $cmd"; exit 2 ;;
esac