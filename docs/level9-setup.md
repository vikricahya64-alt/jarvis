# Level 9 — Symbiotic Consciousness

**Objective:** Guard the constitution, protect a digital legacy, align values,
offload cognitive decisions transparently, and audit the system's existence
with radical honesty. All new modules are **libraries** (handler count stays 12).

## Modules (all synchronous, fail-safe)

| Module | Purpose |
|---|---|
| `utils/constitutional_guard.py` | Fail-closed guard: no constitution → block all non-whitelist actions. Groq verdict + local fallback + versioned amendments. |
| `utils/legacy_vault.py` | Dead man's switch (grace 30 d) + multisig (2 contacts) + AES-256-GCM vault, dry-run, irreversible-wipe escalation. Includes Fly.io scaffold. |
| `utils/value_alignment.py` | Drift tracking (>5 corrections/domain in 14 d), Groq proposal, explicit confirm/expire (TTL 7 d). Never auto-applies. |
| `utils/cognitive_offload.py` | Decision journal (append-only), energy-aware delegation gate, priority alignment, `/undo_decision` reversal, weekly digest. |
| `utils/existential_audit.py` | Quarterly (90 d) + manual radical-honesty audits; dialogue presentation; follow-up actions (amend/pause). |

## Constitution & Guard

```bash
# Template to seed data/personal_constitution.md, then:
#   either paste as /amend_constitution <seksi> <isi>, or load the file
#   into the personal_constitution table (v1) via Supabase console/SQL.
```

- **Fail-closed:** without a constitution row, `validate_action()` returns
  `allowed=False, violated_principle='no_constitution'`.
- **Whitelist** (`_ALLOWED_BY_DEFAULT` in the module): structural actions are
  permitted without Groq.
- **Amendments** bump `version`, append `amendment_rationale`; protected
  sections (`legacy`, `encryption_key`) are refused via backend guard.
- Every violation is logged to `constitutional_violations` (append-only,
  `action_hash` unique).

## Database — apply `sql/level9_schema.sql`

Run against the **prod pooler** (ref `vujhyhvmibdkartmrepv`) with the
service-role credential:

```bash
psql "postgres://postgres.vujhyhvmibdkartmrepv:${PGPASSWORD}@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres" \
  -f sql/level9_schema.sql
```

Tables: `personal_constitution`, `constitutional_violations`, `legacy_plans`,
`value_interpretations`, `decision_journal`, `existential_audits`. All RLS via
`get_telegram_id()`; `decision_journal` is INSERT+SELECT only (immutable);
reversal is a service-role outcome patch.

## Env (Vercel Secret)

- `SUPABASE_URL` = `https://vujhyhvmibdkartmrepv.supabase.co`
- `SUPABASE_SERVICE_KEY`, `SUPABASE_KEY`, `TELEGRAM_TOKEN`
- `BACKUP_PASSPHRASE` — used for legacy vault AES-GCM (store via Secret; never
  in git).
- `JARVIS_DMS_GRACE_DAYS` (default 30), `JARVIS_MULTISIG_THRESHOLD` (2),
  `JARVIS_TERMINATE_WINDOW_H` (72).

## Telegram commands

| Command | Action |
|---|---|
| `/constitution_status` | Show current constitution + amendment count |
| `/amend_constitution <seksi> <isi>` | Propose/apply a new amendment (v+1) |
| `/legacy_setup transfer\|delete\|release\|archive\|none` | Store encrypted legacy intent |
| `/legacy_test` | Dead man's switch status (dry-run, never executes) |
| `/value_drift_report` | Drift signals + pending value proposals |
| `/confirm_value <id>` / `/reject_value <id>` | Setuju/tolak proposal nilai |
| `/decision_journal` | Latest delegated decisions (append-only) |
| `/undo_decision <id>` | Reverse a decision (journal intact) |
| `/existential_check` | Run radical-honesty existential audit |
| `/terminate_system` | Begin irreversible wipe protocol (72 h + 2 contacts) |

> L9 guard operates on library level; no new handler reserved in `__metafile`
> — handler page stays at 12.

## Tests

```bash
cd /workspace/jarvis
python3 tests/test_level9.py          # plain asserts
# or: python3 -m pytest tests/test_level9.py -v
```

## Dead Man's Switch — 24/7 host (Fly.io / Render)

Vercel Hobby sleeps between requests, so the heartbeat monitor must live on an
always-on worker. The repo ships a ready scaffold:

- `tools/legacy_monitor_fly.py` — loop that evaluates the DMS + serves
  `/healthz`. **Fail-safe by default**: without `--execute` it never acts even
  when armed.
- `fly.toml` + `Dockerfile.fly` — single tiny instance (Tokyo, `nrt`).

### Deploy to Fly.io

```bash
cd /workspace/jarvis
fly launch --no-deploy                 # creates app, reads fly.toml
fly secrets set \
  SUPABASE_URL=https://vujhyhvmibdkartmrepv.supabase.co \
  SUPABASE_SERVICE_KEY="<secret>" \
  SUPABASE_KEY="<anon>" \
  BACKUP_PASSPHRASE="<secret>" \
  TELEGRAM_TOKEN="<secret>" \
  JARVIS_DMS_GRACE_DAYS=30 \
  JARVIS_MULTISIG_THRESHOLD=2 \
  JARVIS_TERMINATE_WINDOW_H=72 \
  JARVIS_TG_OWNER=0 \
  JARVIS_DMS_INTERVAL_S=21600
fly deploy
fly open
```

First deploy runs **dry-run** (`JARVIS_DMS_EXECUTE=0`, the default in
`fly.toml`), so the monitor only logs and exposes `/healthz`. To let the switch
actually act once armed AND multisig-met, flip the flag and deploy purely with
`fly secrets set JARVIS_DMS_EXECUTE=1` (do this only after you trust the
monitoring and have set `BACKUP_PASSPHRASE`).

Failure behaviour is safe: the monitor never auto-triggers destruction; a
runtime error logs and defers. Destructive escalation still requires the
`terminate_system` 72h window + 2 trusted contacts via the bot.

### Dry run (no Fly) to sanity-check

```bash
python3 tools/legacy_monitor_fly.py --once    # prints JSON, never acts
```

### Design invariants (fail-safe, not fail-open)

| Invariant | Guarantee |
|---|---|
| No destructive action without `--execute`/`JARVIS_DMS_EXECUTE=1` | monitor stays dry-run |
| `encrypted_blob` is AES-256-GCM | legacy content never plaintext at rest |
| Decrypt only after multisig threshold | 2+ trusted contacts, in-memory only |
| `decision_journal` INSERT+SELECT only | immutable, reversal is a backend patch, never a delete |
| Value proposals need explicit confirm | never auto-applied; TTL 7d expire |
| No constitution / engine error | guard blocks (`no_constitution` / `validation_unavailable`) |