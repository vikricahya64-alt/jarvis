# Level 10 — Migration Strategy: Vercel → Fly.io (Zero-Downtime)

This document is the runbook for moving J.A.R.V.I.S. core from Vercel serverless
to Fly.io multi-region without downtime, transferring persistent state safely,
testing failover, and a rollback path.

## 0. Free-tier budget reality (read first)

Fly free tier = **3 × shared-cpu-1x 256MB VMs + 3GB volume TOTAL**, across *all*
regions. You cannot run 1 VM in sin + 1 in nrt + 1 in ord + ephemeral workers
and stay free. Budget plan:

- 1 VM  = primary (sin) — the main ASGI app.
- 1 VM  = failover standby (nrt) — auto-stopped unless needed.
- 1 VM  = shared slot for ephemeral worker bursts (auto-destroyed) OR the L9
  legacy monitor. Pick ONE at a time.
- ord   = **documented** but only manually brought up in an emergency (consume
  the 3rd slot); destroyed when the crisis ends.

Keep `fly.toml` `[services] auto_stop_machines=true` and ephemeral `auto_destroy`
so idle capacity collapses to 0.

## 1. What migrates / what stays

| Concern | Destination |
|---|---|
| Webhook receiver + orchestrator pipeline | Fly ASGI `api/fly_app.py` (reuses `api/webhook.py` pipeline) |
| State (SQL + pgvector) | Supabase remains single source of truth — **no** local DB migration needed |
| In-memory caches | Dropped; use Supabase + the L9 guards' TTL LRU caches |
| Cron (daily maintenance) | Fly scheduled machines (not Vercel cron) |
| Constitution / legacy / value / journal | Stays in Supabase with new `pinned_region` + RLS |
| Private heavy compute | Oracle ARM (Ollama + federated aggregator) — unchanged |
| Edge terminal | Realme C25s via Tailscale — unchanged |

Because the DB is already remote (Supabase), the "state transfer" step is
mostly **config**, not data migration.

## 2. Phase A — Prepare (do in current Vercel prod)

1. Ensure `TELEGRAM_SECRET_TOKEN` is set (webhook signature). If not, set it
   and update the webhook URL secret before cutover.
2. Confirm `data/personal_constitution.md` v1 exists (already seeded) so the
   Guard is not fail-closed.
3. Add new env secrets to both Vercel and Fly for parity:
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `BACKUP_PASSPHRASE`,
   `TELEGRAM_TOKEN`, `JARVIS_DMS_GRACE_DAYS`, `OWNER_CHAT_ID`.
4. Deploy the code now so both stacks run the same commit.

```bash
# apply the residency migration (already applied on prod; re-run is idempotent)
PGPASSWORD=... python3 tools/apply_sql.py --commit sql/level10_data_residency.sql
```

## 3. Phase B — Build the Fly app

```bash
fly launch --no-deploy                # creates app; keeps fly.toml
fly volumes create jarvis_state --size 3 --region sin
fly secrets set \
  SUPABASE_URL=https://vujhyhvmibdkartmrepv.supabase.co \
  SUPABASE_SERVICE_KEY=<svc> \
  BACKUP_PASSPHRASE=<pass> \
  TELEGRAM_TOKEN=<tok> \
  TELEGRAM_SECRET_TOKEN=<tok-secret> \
  OWNER_CHAT_ID=<id> \
  FLY_APP=jarvis-ubiquitous \
  FLY_REGION=sin PRIMARY_REGION=sin
fly deploy --strategy rolling
fly status
```

Health check `/health` + `/healthz` gate the roll.

## 4. Phase C — Cut over webhook with a shadow run

1. First, **point Telegram webhook to Fly and the old Vercel to a spare** — but
   keep Vercel team/branch deployments alive for instant rollback.
2. Set Telegram webhook to `https://jarvis-ubiquitous.fly.dev/api/webhook` with
   your secret token.
3. Verify `curl https://jarvis-ubiquitous.fly.dev/health` returns `ok:true`.
   Then fire a `/ping`-style command and confirm the reply + `(sin)` tag.

```bash
# update webhook
curl -s -X POST https://api.telegram.org/bot<TOK>/setWebhook \
  -d "url=https://jarvis-ubiquitous.fly.dev/api/webhook" \
  -d "secret_token=<token-secret>"
```

## 5. Phase D — Test failover manually

```bash
# simulate primary failure (stop sin machine)
fly machine stop <sin-machine-id>
# a region_status should show failover to nrt and the user gets:
#   "🌐 Optimizing connection via nrt"
fly machine start <sin-machine-id>   # rollback path
```

The `failover_manager` will, on next health tick, move routing back to sin
(`rollback_to_primary`). Confirm `/region_status`.

## 6. Monitoring free-tier usage

- `/region_status` and `/worker_queue` in chat.
- `fly status --all` and `fly logs`.
- Git-tracked `docs/level10-free-tier-guide.md` thresholds + alert notes.
- Watch `fly volumes list` (3GB cap) and machine count (3 cap).

## 7. Rollback to Vercel (safety net)

1. Re-point the Telegram webhook back to `https://jarvis-sigma-navy.vercel.app/api/webhook`.
2. Leave the Fly machines running (or destroy them) — Vercel code is unchanged
   and already on the same commit.
3. Verify `/health` on Vercel returns all green and `pending_update_count=0`.

```bash
curl -s -X POST https://api.telegram.org/bot<TOK>/setWebhook \
  -d "url=https://jarvis-sigma-navy.vercel.app/api/webhook" \
  -d "secret_token=<token-secret>"
```

## 8. Emergency destruction

`/terminate_system` (with 72h + 2-contact multisig) will, once confirmed,
destroy all Fly machines and wipe the `jarvis_state` volume. The Dry-run note is
surfaced in chat before anything destructive.

## 9. Cut-over checklist

- [ ] `fly launch`, volume, secrets set
- [ ] `/health` + `/healthz` green on Fly
- [ ] Residency migration applied (pinned_region + RLS) — **done**
- [ ] Webhook moved with secret token
- [ ] `region_status`, `worker_queue`, `data_residency_audit` reply correctly
- [ ] Failover + rollback tested
- [ ] Vercel kept as rollback (webhook URL documented for instant revert)