# J.A.R.V.I.S. — Cloudflare sovereign stack (Level 10/11) setup guide

Worker `jarvis-sovereign` menggantikan DMS cloud Python. Ia adalah **mesin
kepatuhan otoritatif** — keputusan kelangsungan (DMS), obedience audit, dan
hierarki perintah semuanya di sini. Realme C25s **tidak lagi** menjalankan
beban on-device (lihat `docs/level6-device-setup.md` DEPRECATED).

## Arsitektur satu-Worker

```
Cron (3) ──► scheduled() ──► runDms()/value_alignment (D1)
Telegram  ──► /webhook ──► handleUpdate() ──► routeCommand() (Groq klaifikasi + D1)
Queues    ──► jarvis-tasks ──► queue() ──► processMessage()
                                              │
                                  D1 (state, audit, consent, vault-meta)
                                  R2 (legacy vault payloads)
                                  KV (config/certs — bukan audit)
```

## 1. Prasyarat

- Akun Cloudflare + pembayaran **tidak wajib** (paket free cukup).
- `wrangler` CLI: `npm i -g wrangler` lalu `wrangler login`.
- Node 18+ untuk `npx tsx test/safety.test.ts` (opsional, hanya untuk uji keamanan).

## 2. Setup & deploy

```bash
cd cf
cp .dev.vars.example .dev.vars      # isi nilai dev (jangan commit)
bash deploy.sh setup                 # buat D1, KV, R2, Queues → salin ID ke wrangler.toml
#   1) Tempel database_id, kv id, queue names dari output ke cf/wrangler.toml
bash deploy.sh migrate               # terapkan migrations/0001_init.sql ke D1 remote
bash deploy.sh secrets               # set TELEGRAM_TOKEN, TELEGRAM_SECRET, GROQ_API_KEY
bash deploy.sh deploy                # wrangler deploy
bash deploy.sh webhook <workers-url> # arahkan Telegram → /webhook
```

> `bucket_name = "jarvis-vault"` harus cocok dengan yang kamu buat. Jika beda,
> samakan nama di `wrangler.toml`.

## 3. Verifikasi

```bash
curl https://<worker>.workers.dev/healthz
# → {"ok":true,"ts":...}

# kirim /dms_status ke bot → eksekusi state machine manual
# kirim /health → "Health: sehat"
```

## 4. Budget free-tier yang kamu pakai

| Sumber | Kontinjen | Penggunaan |
|--------|-----------|-----------|
| Workers | 100k req/hari, 10ms CPU/req | 1 worker, semua jalur |
| Cron | 5 trigger | 3 (DMS 6h, value-& align daily, report Minggu) |
| D1 | 5GB, 100k read/hari | state + audit + consent (+ indeks) |
| R2 | 10GB, 1M tulis/10M baca | legacy vault payloads |
| Queues | 1M msg/bln | tugas async (reply, notify) |
| KV | 1GB | config, cert notif (bukan audit) |
| Groq | ~14k req/hari | klasifikasi intent (async, di luar CPU) |

Cron **bukan** daemon persisten — tiap trigger adalah request yang dijadwalkan,
jalan pendek lalu keluar. Itu mengapa state machine (D1) menjamin kelangsungan.

## 5. Rollback / emergency

- **Bypass absolut DMS**: kirim ` /stop ` / `/kill` / `/override` dari Telegram
  → `checkIn()` set `stage='idle'` (diuji safety.test).
- **Keluar DMS sengaja (dipakai untuk wipe)**: tutup worker
  (`wrangler deploy --dry-run` ... atau nonaktifkan trigger) — Serverless tak
  menjadwalkan cron, DMS berhenti. Ini adalah saklar darurat manual.
- **TL;DR**: takkan "executed" kecuali benar-benar 24h+48h tanpa interaksi.

## 6. File penting (cf/)

```
wrangler.toml            bindings + vars + cron (3)
migrations/0001_init.sql schema D1
src/index.ts             router + cron + queue
src/workers/task_processor.ts      queue consumer
src/workers/telegram_webhook.ts    webhook + inline consent
src/lib/command_hierarchy.ts       prioritas + clarity + consent + audit
src/lib/dead_mans_switch.ts        state machine D1 (stage transitions)
src/lib/zero_trust.ts              mTLS/context
src/lib/db.ts / telegram.ts        helper
.dev.vars.example        contoh secrets
deploy.sh                wrapper perform setup/deploy/secrets/webhook
test/safety.test.ts      uji keamanan kritis (npx tsx)
```