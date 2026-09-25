# J.A.R.V.I.S. — Cloudflare sovereign stack (Level 10/11) setup guide

Worker `jarvis-sovereign` menggantikan DMS cloud Python. Ia adalah **mesin
kepatuhan otoritatif** — keputusan kelangsungan (DMS), obedience audit, dan
hierarki perintah semuanya di sini. Realme C25s **tidak lagi** menjalankan
beban on-device (lihat `docs/level6-device-setup.md` DEPRECATED).

## Arsitektur satu-Worker

```
Telegram ──► /webhook ──► telegram_gate.handleIncoming ──► handleUpdate()
                              │  (SATU pintu masuk, router disuntik
                              │   oleh index.ts via registerUpdateRouter)
                              │              │
                              │              ▼
Cron (3) ──► scheduled() ──► runDms()/value_alignment (D1)   processIntelligence()  (otak)
Queues  ──► jarvis-tasks ──► queue() ──► processMessage()         │
                                              │                  │ (gate anti-halusinasi input)
                                              ▼                  ▼
                              semua output Telegram LEBIH DULU lewat
                              telegram_gate.emit* (SATU pintu keluar)
                              ─ emitText / emitSmartReply (rail otak) /
                                emitPhoto / emitVoice / emitAnswer /
                                emitEditMarkup — semua teraudit
                                              │
                                              ▼
                                  D1 (state, audit, consent, vault-meta + payload inline)
                                  KV (config/certs — bukan audit)
```

### Prinsip pintu tunggal Telegram (satu pintu masuk + satu pintu keluar)

Kemampuan **fondasi = otak**, kemampuan lain = **tangan/kaki**. Semua lalu
lintas Telegram harus lewat **satu pintu**, jadi tidak ada output (percakapan
maupun notifikasi deterministik cron/agent/DMS) yang bisa menyelinap keluar
tanpa lewat otak.

- `src/lib/telegram_gate.ts` adalah **satu-satunya modul** yang boleh memanggil
  transport `src/lib/telegram.ts`. Modul lain di `src/` DILARANG mengimpor
  transport; semuanya lewat gate (cek: `git grep -l 'from "\./lib/telegram"'`).
- **Masuk (inbound)**: `handleIncoming()` menerima semua update Telegram.
  Router di-suntik sekali di module-scope `index.ts` via
  `registerUpdateRouter(handleUpdate)` (hindari siklus import; fail-closed 500
  tanpa router). Idempotensi `update_id` tetap di dalam `handleUpdate`.
- **Keluar (outbound)**: `emitText` / `emitSmartReply` / `emitPhoto` /
  `emitVoice` / `emitAnswer` / `emitEditMarkup` adalah satu-satunya titik
  keluar; semua tercatat `[telegram_gate] OUT kind=… chat=… src=… len=…`.
- **Rail anti-halusinasi keluar** (`brainExitRail`) berlaku untuk teks ber-origin
  otak (`emitSmartReply`), sebagai lapis KEDUA di luar gate di dalam
  `processIntelligence`: (a) teks vague tanpa subjek → `CLARIFY_EMPTY_SUBJECT`
  (byte-identical dengan gate input, idempotent), (b) kutipan memori tak
  berjangkar ("berdasarkan catatan kita", "seperti yang kita sepakati",
  "Berdasarkan kebingungan yang kamu rasakan tadi") → dibuka ulang menjadi
  "Menurut ingatanku, …". Notifikasi deterministik (cron/agent/DMS) LULUS
  tapi tetap teraudit lewat pintu yang sama.
- **Gate anti-halusinasi input** (di `processIntelligence`) bersifat GLOBAL dan
  HANYA melihat kata-kata user saat ini: `isVagueNoSubject(effectiveText)`
  → pesan vague tanpa subjek ("saya sedang bingung", "bantu aku") selalu
  diklarifikasi. Tidak membaca `isContinuation`/memori (live-veri: overlap
  memori "kerja remote" membuat isContinuation palsu → gate pernah ter-skip
  dan JARVIS menjawab remotework dari memori; goblok itu dihapus permanen).

## 1. Prasyarat

- Akun Cloudflare + pembayaran **tidak wajib** (paket free cukup).
- `wrangler` CLI: `npm i -g wrangler` lalu `wrangler login`.
- Node 18+ untuk `npx tsx test/safety.test.ts` (opsional, hanya untuk uji keamanan).

## 2. Setup & deploy

```bash
cd cf
cp .dev.vars.example .dev.vars      # isi nilai dev (jangan commit)
bash deploy.sh setup                 # buat D1, KV, Queues → salin ID ke wrangler.toml
#   1) Tempel database_id, kv id, queue names dari output ke cf/wrangler.toml
bash deploy.sh migrate               # terapkan migrations/0001_init.sql ke D1 remote
bash deploy.sh secrets               # set TELEGRAM_TOKEN, TELEGRAM_SECRET, GROQ_API_KEY
bash deploy.sh deploy                # wrangler deploy
bash deploy.sh webhook <workers-url> # arahkan Telegram → /webhook
```

> Catatan R2: stack ini **tidak memakai R2**. Payload vault disimpan INLINE di
> D1 (`encrypted_blob`, bermigrasi di `0002_legacy_inline.sql`) — karena R2 itu
> layanan usage-based yang **wajib kartu** (tab object storage diskuning tanpa
> billing), sedangkan D1 masuk kategori *non-metered free plan* yang **tanpa kartu**.

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
| D1 | 5GB, 100k read/hari | state + audit + consent + payload inline (+ indeks) |
| ~~R2~~ | — | **tidak dipakai** (butuh kartu; pakai D1 inline) |
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

## 5b. Kemampuan Level 11 (migrasi dari python) yang kini ada di CF

Stack ini mewarisi SEMUA kemampuan hierarki perintah L11 python sebelumnya:

| Kemampuan (L11 python → CF) | Lokasi CF | Cara pakai |
|------------------------------|-----------|-----------|
| Priority tiers 100/90/70/50/30 | `command_hierarchy.ts` TIERS | otomatis per perintah |
| Intent Groq + fallback deterministik | `groqClassify`/`heuristicClassify` | otomatis |
| Risk score numerik (0.9/0.5/0.1) | `constitutional_guard.ts` `riskScore()` | otomatis |
| Prefix eksplisit (`/`, tolong, please, lakukan, harap, stop, kill, override, jangan, never) | `COMMAND_PREFIXES` | otomatis → tier 100 |
| **Constitutional guard fail-closed** (no deceive/destroy/exfiltrate/money) | `constitutional_guard.ts` `validateAction()` | otomatis; blokir aksi berbahaya |
| **Command rules 'never/stop'** + conflict_score | `markExplicitStop()` + `conflictScore()` | `/never <frasa>` atau `/mark_stop <frasa>` |
| **Autonomy pause global** | `setAutonomyPaused()`/`isAutonomyPaused()` | `/pause` dan `/resume` |
| **Consent inline Approve/Deny/Pause + timeout default-DENY** | webhook callback `consent:` | otomatis untuk aksi berisiko |
| **Clarification options flow** | webhook callback `clarify:` | otomatis saat ambiguity |
| Obedience audit append-only | `obedience_audit` (D1) | tiap perintah tercatat |

Perintah Telegram baru: `/never <frasa>`, `/mark_stop <frasa>`, `/pause`,
`/resume`, `/obedience_report`, `/queue_status`, `/dms_status`.

## 5c. Kognitif edge (menutup gap L4→L8/L10)

Selain kepatuhan, edge kini punya jalur penalaran nyata di `lib/ai.ts`
(fail-closed: saat offline/Groq kosong ia mundur ke balasan template, tak pernah
menimbulkan error):

| Kemampuan | Lokasi | Cara pakai |
|-----------|--------|-----------|
| **Respon generatif Groq** (llama-3.3-70b) | `groqRespond()` | otomatis — jawaban kalimat utuh, bukan label canned |
| **Web search DuckDuckGo** (gratis, tanpa API key) | `ddgSearch()` | otomatis — kirim `cari <topik>` / `ringkas <artikel>` |
| **Sintesis pencarian + LLM + konteks** | `searchAndSynthesize()` | otomatis di jalur EXECUTE untuk teks ber-topik |
| **Memori giliran percakapan** (last N turn) | `appendMemory()`/`recentContext()` → `conversation_log` (D1) | otomatis; dibatasi ~100 turn per owner |
| **Riwayat antrean kumulatif** (lifetime, bukan depth) | `recordTaskCounters()` → `task_counters` (D1) | otomatis; lihat `/queue_status` |
| **Laporan kepatuhan Mingguan dikirim** (dulu log-only) | `index.ts` `sendWeeklyObedienceReport()` | cron `0 8 * * *` (Minggu) |

Contoh: `cari tentang implementasi iscsi` → DDG ambil hasil → Groq rangkum →
balasan ke Telegram + giliran disimpan sebagai konteks turn berikutnya.

## 5d. Level 12 — Transcendent Steward (covenant, identity, maestro, degradasi)

Level 12 menaikkan J.A.R.V.I.S. dari mesin kepatuhan menjadi maestro proaktif,
tetap **di bawah hierarki perintah dan consent pemilik**. Semua free-tier
(tanpa R2/IPFS — butuh kartu; sunset sengaja preview-only, tak ada purge
ireversibel). Detail identitas & alur: `docs/level12.md`.

| Modul | Lokasi | Perintah |
|-------|--------|----------|
| **Immutable Covenant** (append-only, trigger RAISE(ABORT)) | `covenant_core.ts` + `0005` | `/covenant_status`, `/covenant_sign <klausa>` |
| **Identity Anchor** (rantai epoch temporal + hash snapshot) | `identity_anchor.ts` + `0005` | `/identity_verify` |
| **Autonomous Maestro** (decompose→plan→step, consent-guarded, audited) | `maestro.ts` + `0004` | `/maestro_status` |
| **Graceful Degradation** (kuota → disable fitur non-esensial) | `degradation.ts`/`monitor.ts` + `0004` | `/degradation_status` |
| **Sunset Preview** (evaluasi read-only, tanpa purge) | handler webhook | `/sunset_preview` |

Cron L12 (identity epoch + quota refresh) dijalankan dari cron `0 */6` yang
sudah ada — **tidak menambah trigger**, tetap 3/5 dalam budget free-tier.

Aturan kedaulatan (tetap matuh perintah Anda):
1. Covenant immutable di tingkat DB — AI bisa baca, tak bisa ubah/hapus.
2. Autonomous hanya untuk item **eksplisit didelegasikan** + lolos
   `validateActionAgainstCovenant`; semua eksekusi dicatat (origin=autonomous).
3. `/pause` menghentikan maestro sepenuhnya.
4. Fitur esensial (covenant/DMS/override) **tidak pernah** dimatikan oleh degradasi.
5. Sunset preview TIDAK mengeksekusi purge — inisiasi manual + konfirmasi ganda.

## 5e. Level 13 — Reflective Apprentice (self-improvement yang aman)

Level 13 menaikkan J.A.R.V.I.S. dari steward menjadi *pembelajar*: merefleksikan
output (1-ronde), mengonsolidasikan pengalaman harian menjadi insight berbukti,
beradaptasi pada preferensi pemilik, dan mengirim briefing pagi *skip-if-nothing*.
Tetap 100% free-tier, append-only, dan di bawah kedaulatan pemilik. Detail:
`docs/level13.md`.

| Modul | Lokasi | Perintah |
|-------|--------|----------|
| **Verbal Reflection** (Relexion/Self-Refine, 1-ronde) | `evolution.ts` + `0007` | `/reflect` |
| **Dreaming Consolidation** (cron `0 7`) | `evolution.ts`/`index.ts` | otomatis |
| **Experiential Insight** (≥3 bukti, ExpeL) | `evolution.ts` + `0007` | `/insights`, `/disable-insight`, `/audit-phantom` |
| **Adaptive Preference** (confidence+TLL) | `evolution.ts` + `0007` | `/preferences`, `/set-preference`, `/disable-preference` |
| **Morning Sentinel** (skip-if-nothing) | `evolution.ts`/`index.ts` | otomatis |

Cron L13 (`0 7 * * *`) ditambah dari 3 → 4 (tetap ≤5 dalam budget free-tier) dan
memakai cron-lock D1. `ai.ts` menyisipkan preferensi+insight aktif ke konteks LLM
dan memicu refleksi bounded (fire-and-forget) tanpa mengubah sistem-prompt.

## 5f. MCP adapter — JARVIS bicara MCP dua arah (server + client)

MCP (Model Context Protocol, spek 2026-07-28/stateless) dijadikan **lapisan
adapter**, bukan pengganti inti: brain tetap `processIntelligence` (single-door,
owner-framed). JARVIS menjadi **MCP server sekaligus MCP client** pada Worker
yang sama.

**Arah server** (external host memanggil otak JARVIS):
- Endpoint `GET/POST /mcp` (HTTP+SSE, stateless). Tools yang diekspos:
  `jarvis_ask` (ke `processIntelligence`, text ≤1000 chars), `memory_search`,
  `memory_save`, `connectors_status`, `jarvis_status`.
- Auth **Bearer**; `MCP_ACCESS_TOKEN` adalah secret (via `deploy.sh secrets`).
  Tanpa secret → `/mcp` = **503**; token salah → **401** (fail-closed).

**Arah client** (JARVIS memanggil tool server MCP lain):
- Komando Telegram `/mcp`:
  ```
  /mcp                        → status + daftar server aktif (tanpa jaringan)
  /mcp list <alias>           → daftar tool live di server tsb
  /mcp <alias> <tool> [<json>] → panggil tool (argumen opsional JSON)
  ```
- `MCP_SERVERS` = secret JSON array (allow-list; malformed → nol server):
  ```json
  [{"alias":"brain","url":"https://jarvis.mcp.example.com/mcp","token":"…","tools":["memory_save"]}]
  ```
  Alias `[a-z0-9][a-z0-9_-]*`, maks 8; URL wajib `https://`. `tools` (opsional) =
  allow-list per server; tool di luar daftar ditolak SEBELUM jaringan.
- `MCP_ENABLED` (`wrangler.toml`, default `"1"`) mematikan permukaan `/mcp`.
  `MCP_SERVER_TIMEOUT_MS` (default 20000) membatasi SATU panggilan keluar.
- SDC SDK: `@modelcontextprotocol/server@2.1.0` + `@modelcontextprotocol/client@2.1.0`
  (bundling worker terverifikasi via `wrangler deploy --dry-run`). Semua util
  memory/panggilan memakai jalur fail-closed (`safeTokenEqual` constant-time).
  Harap dicatat: Jarvis TIDAK pernah mengekspor kredensial internal (token Vercel/
  GitHub) sebagai tool MCP; yang diekspor hanya jalur brain yang sudah digate.

## 6. File penting (cf/)

```
wrangler.toml            bindings + vars + cron (4) + MCP vars
migrations/0001_init.sql schema D1
migrations/0002_legacy_inline.sql inline vault payload
migrations/0003_upgrade.sql task_counters + conversation_log
migrations/0004_maestro.sql maestro (plans/plan_steps/scheduled_tasks) + degradasi
migrations/0005_covenant.sql covenant immutable + identity epoch + quota + sunset preview
migrations/0006_resilience.sql circuit breaker, observability, FTS5 memory, cron lock
migrations/0007_evolution.sql L13: reflection_log, insights, owner_preferences, dream_cycles
src/index.ts             router + cron + queue (+ laporan Mingguan, identity epoch, quota, dream L13)
src/workers/task_processor.ts      queue consumer
src/workers/telegram_webhook.ts    router inbound (disuntik ke gate) + consent/clarify + perintah L12/L13
src/lib/telegram_gate.ts  ⭐ SATU PINTU Telegram (libat transport; handleIncoming + emit* + brainExitRail)
src/lib/ai.ts            groqRespond + ddgSearch + searchAndSynthesize (kognitif) + refleksi + CLARIFY_EMPTY_SUBJECT/isVagueNoSubject
src/lib/intelligence.ts  processIntelligence (otak) + gate input global anti-subjek-dari-memori
src/lib/resilience.ts    circuit breaker, retry/timeout, observability, cron lock D1
src/lib/evolution.ts     L13: refleksi, konsolidasi, insight, preferensi, sentinel, guardrail
src/lib/command_hierarchy.ts       prioritas + clarity + consent + audit + pause
src/lib/constitutional_guard.ts    fail-closed constitution (L11 python port)
src/lib/covenant_core.ts           covenant immutable (signing INSERT-only + validasi)
src/lib/identity_anchor.ts         rantai epoch identitas temporal
src/lib/maestro.ts                 maestro otonom (decompose + schedule + execute)
src/lib/degradation.ts             kuota free-tier → feature disable (non-esensial)
src/lib/mcp/config.ts              allow-list MCP_SERVERS (fail-closed) + konstanta
src/lib/mcp/server.ts              JARVIS sebagai MCP server (endpoint /mcp, Bearer auth)
src/lib/mcp/client.ts              JARVIS sebagai MCP client (adapter panggilan keluar + summary)
src/lib/monitor.ts                 refresh kuota + status + alert degradasi
src/lib/dead_mans_switch.ts        state machine D1 (stage transitions)
src/lib/zero_trust.ts              mTLS/context
src/lib/db.ts / telegram.ts        helper (telegram.ts = transport KONSUMENNYA HANYA telegram_gate)
.dev.vars.example        contoh secrets
deploy.sh                wrapper perform setup/deploy/secrets/webhook
test/safety.test.ts      uji keamanan kritis (npx tsx)
test/mcp.test.ts         uji MCP dua arah + rails fail-closed (npx tsx; `npm run test:mcp`)
```

## 7. Verify cepat
- `npm run typecheck`          # tsc --noEmit
- `npm run test:safety`        # uji keamanan kritis
- `npm run test:logic`         # uji logika webhook/brain
- `npm run test:mcp`           # uji MCP server+client (InMemory transport)
- `npx wrangler deploy --dry-run`  # pastikan SDK MCP ter-bundle tanpa error