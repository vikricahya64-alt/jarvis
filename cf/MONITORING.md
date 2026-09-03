# J.A.R.V.I.S. Cloudflare — monitoring & quota alerts

Tujuan: tahu sebelum brok 80% kuota free-tier, dan tahu saat cron/DMS gagal,
tanpa mendaftar alat baru. Semua lewat `/healthz` + log.

## 1. Endpoint yang bisa dipoll

```
GET  /healthz
     → { ok, ts, env }
GET  /webhook ...  (Telegram; respon cepat, kecil)
```

Untuk memantau ketersediaan, cron tiap 30 menit dari device/termux-cron atau
UptimeRobot (gratis, ping /healthz):

```
curl -fsS https://<worker>.workers.dev/healthz || echo "DOWN"
```

## 2. Ambang kuota yang harus diawasi

| Target | Ambang alarm |
|--------|--------------|
| Workers request/hari (100k) | ≥ 80k/24h |
| D1 read/hari (100k) | ≥ 80k/24h |
| ~~R2~~ Class A/B (1M/10M bln) | **tidak dipakai** (butuh kartu; payload inline D1) |
| Queues msg (1M/bln) | ≥ 800k |
| KV read/hari (100k) | ≥ 80k |

Cloudflare dashboard memberi grafik per-resource. Untuk alarm otomatis tanpa
akun tambahan, jadwalkan cron dari device (termux-cron) atau UptimeRobot untuk
hit `/healthz` dan posting ke Telegram bila non-200 (lihat bot yang sama).

## 3. Melihat log worker (debug quick)

```bash
wrangler tail                    # stream log real-time
# cari baris [cron:*] / [task:*] / [dms:*]
# laporan Mingguan: [cron] obedience_report: sent/skip (not Sunday)
```

## 4. Pola alarm DMS yang perlu diperhatikan

- `[cron] dms: verify(armed)` — mulai Stage 1 (harus cekin dalam 24h+48h).
- `[cron] dms: stage2(armed)` — Stage 2: sisa 48h; PENTING.
- `[cron] dms: executed` — terjadi wipe (hanya jika benar-benar timeout).
- `[cron:*] failed <msg>` — cron salah; cek konsol.

Bila melihat `stage2(armed)` dan kamu **masih ada di sini**, kirim `/checkin`
segera untuk reset ke `idle`.

## 4b. Level 12 (Transcendent Steward) — log & status baru

Cron `0 */6` kini juga menjalankan identity-epoch dan quota refresh (tetap
dalam budget 3/5 trigger):

- `[cron] identity_epoch: <id> verified` — epoch baru dirantai (konfigurasi di-hash).
- `[cron] identity_epoch failed <msg>` — rantai identitas gagal → periksa
  `covenant_clauses`/`identity_epochs`/env. Pastikan konfigurasi tak melenceng.
- `identityStatusText`/`covenantStatusText` — cek via Telegram `/identity_verify`
  dan `/covenant_status`.

Status kuota & degradasi (fitur non-esensial dimatikan saat kuota menipis;
fitur esensial — covenant/DMS/override — **tidak pernah** dimatikan):

- `/degradation_status` — persen kuota + daftar fitur dinonaktifkan.
- Row `degradation_alerts` ditulis saat ada fitur yang ditangguhkan (nanti
  diintegrasikan ke kiriman Telegram).

Immutability covenant: tiap percobaan UPDATE/DELETE pada `covenant_clauses`
ditolak di level DB oleh trigger `prevent_covenant_modification_{update,delete}`
(log error `Covenant is immutable`). Ini **normal** — bukan kegagalan sistem.

Sunset: `/sunset_preview` hanya evaluasi read-only; tidak ada purge ireversibel
yang bisa dipicu lewat perintah.

## 5. Rotasi praktis

- `TELEGRAM_TOKEN`, `TELEGRAM_SECRET`, `GROQ_API_KEY` — set via `bash deploy.sh secrets`.
- Ganti nilai: `wrangler secret put <VAR> --name jarvis-sovereign` lalu redeploy.
- Kredensial yang bocor di chat sebelumnya (Supabase pooler, Fly token,
  TELEGRAM_TOKEN prod) — tetap disarankan rotasi. Secrets kini hidup di
  `wrangler secret`, bukan kode.