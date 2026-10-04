#!/usr/bin/env bash
#==============================================================================
# d1_migrate.sh — apply D1 migrations in a way that is safe to run EVERY time.
#
# WHY THIS EXISTS (no-local-machine setup)
#   This repo's only machines are Cloudflare Workers, GitHub Actions runners and
#   the Vercel/Fly functions. There is no laptop to sit and run
#   `wrangler d1 migrations apply` by hand, so the migration step has to be
#   part of the automated deploy pipeline.
#
#   That is not possible with `wrangler d1 migrations apply` alone: the repo had
#   20 migration files and NO `d1_migrations` ledger, because deploy.yml
#   deliberately skipped the apply step ("migrations apply would try to
#   CREATE_EXISTING tables and fail"). On an empty ledger wrangler replays
#   0001-0020 and dies on the first non-idempotent statement —
#   `ALTER TABLE ... ADD COLUMN` has no IF NOT EXISTS in SQLite and raises
#   "duplicate column name". There are 13 such statements across 8 tables.
#
#   So this script BASELINES the ledger first: it records 0001-0020 as applied,
#   because in the live database they genuinely are. After that,
#   `migrations apply` only executes new files, and is safe to repeat.
#
# IDEMPOTENCE
#   This script is safe to run on every deploy, any number of times:
#     * CREATE TABLE IF NOT EXISTS          -> no-op when it exists
#     * INSERT OR IGNORE INTO d1_migrations  -> no-op when the row exists
#     * guard: baseline only when count < 20, so it never re-stamps a real
#       migration's timestamp
#     * `wrangler d1 migrations apply` skips anything the ledger already has
#   The one thing that is NOT repeatable is `0022_backfill_and_counters.sql`
#   (it contains an ALTER). That is exactly why the ledger has to exist first.
#
# Usage:
#   bash scripts/d1_migrate.sh              # remote (production)
#   bash scripts/d1_migrate.sh --local      # local D1
#
# Requires CF_API_TOKEN + CF_ACCOUNT_ID in the environment (GitHub Actions
# secrets). Locally it falls back to `wrangler login`.
#==============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DB_NAME="jarvis"
MODE="remote (production)"
# The location flag must ALWAYS be present and explicit. An empty flag expands to
# nothing, and wrangler's default is `local` - which silently means a run
# labelled "remote (production)" would baseline and migrate a throwaway local
# SQLite file and report success. That is what happened on the first three CI
# attempts: the log said "remote (production)", the ledger went 0 -> 20, and
# wrangler then printed "Resource location: local".
LOCATION_FLAG="--remote"
if [[ "${1:-}" == "--local" ]]; then
  LOCATION_FLAG="--local"
  MODE="local"
fi

# wrangler is a devDependency of cf/package.json, so it lives in
# node_modules/.bin and is NOT on PATH in CI. The previous "Deploy Worker"
# step worked because it used `npx wrangler`. Resolve in the same order:
# local install first (deterministic, uses the pinned version), then a global
# install, then npx as a last resort.
if [ -x "node_modules/.bin/wrangler" ]; then
  WRANGLER=(node_modules/.bin/wrangler)
elif command -v wrangler >/dev/null 2>&1; then
  WRANGLER=(wrangler)
else
  WRANGLER=(npx wrangler)
fi
echo ">> wrangler: ${WRANGLER[*]}"

d1() { "${WRANGLER[@]}" d1 execute "$DB_NAME" $LOCATION_FLAG --command "$1"; }

# Read a single integer out of wrangler's table output without depending on its
# exact formatting.
#
# Errors are deliberately NOT suppressed here. The first CI run reported a
# ledger count of 0 both before and after the baseline insert, which looked
# like "insert did nothing"; it was actually the query failing and
# `2>/dev/null || echo 0` turning the failure into a plausible-looking 0.
# Wrangler exits non-zero on failure, so let that propagate and print stderr.
d1_count() {
  local out
  # The marker matters. `grep -oE '[0-9]+' | tail -1` over raw wrangler output
  # picks up whatever number happens to be last -- the database UUID, a
  # timestamp, the row count of a different column. That reported a ledger
  # holding 12 rows as "1", which then triggered the baseline path and made
  # the guard refuse. Tag the value so extraction is unambiguous.
  if ! out="$("${WRANGLER[@]}" d1 execute "$DB_NAME" $LOCATION_FLAG \
        --command "SELECT 'JARVIS_LEDGER_COUNT=' || COUNT(*) AS marker FROM $1;" 2>&1)"; then
    echo "d1_migrate: query failed against table $1:" >&2
    echo "$out" | sed 's/^/  /' >&2
    return 1
  fi
  local n
  n="$(printf '%s' "$out" | grep -oE 'JARVIS_LEDGER_COUNT=[0-9]+' | tail -1 | grep -oE '[0-9]+' | tail -1)"
  if [ -z "$n" ]; then
    echo "d1_migrate: could not read a count out of the response for $1:" >&2
    echo "$out" | sed 's/^/  /' >&2
    return 1
  fi
  printf '%s' "$n"
}

# --------------------------------------------------------------------------
# Account resolution.
#
# CLOUDFLARE_ACCOUNT_ID is not set in this repository (no secret, no variable),
# and `wrangler d1 execute` cannot resolve the account without it. Rather than
# requiring an operator to add a secret on a machine nobody has, derive it from
# the API token that IS present.
# --------------------------------------------------------------------------
resolve_account() {
  if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    echo ">> account id: from CLOUDFLARE_ACCOUNT_ID"
    return 0
  fi
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    # Not fatal. A developer who ran `wrangler login` has an OAuth session in
    # ~/.wrangler and needs no env vars at all; wrangler will resolve the
    # account itself. If it genuinely cannot, d1_count below fails loudly with
    # wrangler's own error rather than this pre-emptive guess.
    echo ">> account id: no env credentials; relying on a local wrangler session"
    return 0
  fi
  echo ">> account id: CLOUDFLARE_ACCOUNT_ID unset, deriving from the API token"
  local body acc
  body="$(curl -sS -m 30 -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
          https://api.cloudflare.com/client/v4/accounts 2>&1)" || {
    echo "d1_migrate: Cloudflare accounts request failed:" >&2
    echo "$body" | sed 's/^/  /' >&2
    return 1
  }
  acc="$(printf '%s' "$body" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    sys.exit(f"unparseable response: {e}")
if not d.get("success"):
    errs = d.get("errors") or []
    sys.exit("api error: " + "; ".join(str(x.get("message", x)) for x in errs))
accs = d.get("result") or []
if not accs:
    sys.exit("token has access to no accounts")
print(accs[0]["id"])
' 2>&1)" || { echo "$acc" | sed 's/^/  /' >&2; return 1; }
  CLOUDFLARE_ACCOUNT_ID="$acc"
  export CLOUDFLARE_ACCOUNT_ID
  echo ">> account id: ${CLOUDFLARE_ACCOUNT_ID}"
}

echo ">> mode: $MODE  (wrangler $LOCATION_FLAG)"

resolve_account

# ---------------------------------------------------------------- ledger table
d1 "CREATE TABLE IF NOT EXISTS d1_migrations(
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );" >/dev/null

# ------------------------------------------------------- baseline 0001..0020
BASELINE_COUNT="$(d1_count d1_migrations)"
echo ">> ledger currently holds ${BASELINE_COUNT} applied migration(s)"

HISTORIC="0001_init.sql,0002_legacy_inline.sql,0003_upgrade.sql,0004_maestro.sql,0005_covenant.sql,0006_resilience.sql,0007_evolution.sql,0008_predictive.sql,0009_behavior_feedback.sql,0010_monitoring_infra.sql,0011_todos.sql,0012_ecommerce.sql,0013_reconcile.sql,0014_reminders.sql,0015_recurring_reminders.sql,0016_agent_tasks.sql,0017_agent_tasks_artifact_url.sql,0018_agent_task_rules.sql,0019_covenant_text.sql,0020_memories_owner_scoped.sql"

if [[ "${BASELINE_COUNT}" -lt 20 ]]; then
  echo ">> baselining any missing 0001-0020 rows (they ARE applied in this DB;
>> INSERT OR IGNORE leaves rows the ledger already holds untouched)."
  VALUES=""
  IFS=',' read -ra NAMES <<< "$HISTORIC"
  for n in "${NAMES[@]}"; do
    [[ -z "$VALUES" ]] && VALUES="('$n')" || VALUES="$VALUES,('$n')"
  done
  d1 "INSERT OR IGNORE INTO d1_migrations (name) VALUES $VALUES;" >/dev/null
  BASELINE_COUNT="$(d1_count d1_migrations)"
  echo ">> ledger now holds ${BASELINE_COUNT} migration(s)"
fi

if [[ "${BASELINE_COUNT}" -lt 20 ]]; then
  echo "!! ledger has fewer than 20 rows; refusing to apply migrations." >&2
  echo "!! running apply now would replay 0001-0020 and abort on an ALTER." >&2
  exit 1
fi

# ------------------------------------------------------------------- apply
echo ">> applying pending migrations (0021+)"
"${WRANGLER[@]}" d1 migrations apply "$DB_NAME" $LOCATION_FLAG

echo ">> final ledger:"
d1 "SELECT id, name, applied_at FROM d1_migrations ORDER BY id;"

echo ">> OK"