# JARVIS Self-Referential Bug Anchored Summary

## Goal
Perbaiki jawaban self-referential JARVIS ("apa yang bisa kamu lakukan") yang masih mengarang tentang uang, dengan identitas sebagai single source of truth dan guard berlapis di semua jalur eksekusi.

## Constraints & Preferences
- Free-tier permanen: CF Worker 100k req/hari; Vercel Hobby max 12 serverless functions/deployment
- Kedaulatan pemilik; guard fail-closed; balas Bahasa Indonesia; wajib typecheck/deploy/healthz
- Token CF: `export CLOUDFLARE_API_TOKEN=$(grep -oP '^CLOUDFLARE_API_TOKEN=\K.*' /tmp/.cf_token)`; pakai `npx wrangler`
- Bot @VikriJarvisBot → CF worker (webhook live), Vercel Python adalah backstop/paralel
- Token bot tersimpan lokal di `~/.codex/telegram-bridge.json` (JANGAN commit token ke repo — nilai sudah di-revoke setelah bocor di versi sebelumnya SEMANTIC)
- Jangan deleteWebhook (bot aktif); set webhook secret header via `TELEGRAM_SECRET` (wrangler secret)

## Progress

### Done
- **Guard self-ref cognition-level di CF** (`cf/src/lib/ai.ts`): intercept di `llmRespond()` paling atas (sebelum provider) + guard `searchAndSynthesize()`; return `JARVIS_IDENTITY.selfRefReply` tanpa panggil LLM eksternal. Source type diperluas jadi include `"self_ref"`.
- **Deploy CF `9b11d1f8`** — live 100%, typecheck `tsc --noEmit` clean (exit 0), healthz OK.
- **Supreme Orchestrator architecture REMOVED (cleanup)** — `supreme_orchestrator.ts`, `di_container.ts`, `module_contract.ts`, `context_sanitizer.ts`, `loop_scheduler.ts`, `task_processor.ts` + `queue()` handler di index.ts DIHAPUS sebagai dead code (tidak pernah diimport; queue binding nonaktif). Routing tetap di `telegram_webhook.ts` dan jalur cron langsung di `index.ts`.
- **SELF_REF_RE centralized** (`cf/src/lib/identity.ts`): single source of truth with "uang" typo variant. Imported by intelligence.ts, ai.ts, telegram_webhook.ts.
- **Prefix strip** (`cf/src/workers/telegram_webhook.ts`): strips Telegram group "Username:" prefix before SELF_REF_RE test for ^ anchor.
- **Python identity.py**: "uang" variant added for Vercel parity.
- **Fix Python/Vercel paralel**:
  - `utils/identity.py` (baru): `SELF_REF_RE`, `SELF_REF_REPLY`, `SYSTEM_PROMPT_IDENTITY_BLOCK`, `is_self_referential()`.
  - `api/orchestrator.py`: intercept self-ref di awal `_run_pipeline()` (mark DONE + `_notify_user` + return sebelum LLM).
  - `api/webhook.py`: guard self-ref SEBELUM routing hybrid/photo/command (mencakup jalur local device).
  - `utils/groq_client.py`: `_identity_block()` disisipkan ke system prompt di `_build_messages`.
  - `vercel.json`: sempat tambah `builds` array → **merusak routing** → direvert ke `functions`-only.
  - `.vercelignore`: tambah `api/fly_app.py` untuk tetap ≤12 functions (penyebab blokir deploy Hobby).
- **Satukan SELF_REF_RE ke single source of truth** (`cf/src/lib/identity.ts`): ekspor regex yang telah termodsifikasi ke seluruh module (intelligence.ts, ai.ts, telegram_webhook.ts), dengan varian baru `apa uang bisa kamu (lakukan|bantu|buat)` menangkap typo "uang"→"yang".
- **Update semua module CF** untuk import dari `identity.ts` (bukan lagi regex lokal):
  - `intelligence.ts`: import + hapus definisi lokal baris 131
  - `ai.ts`: import + replace 2x regex lokal di `llmRespond` dan `searchAndSynthesize` (baris 383, 578)
  - `telegram_webhook.ts`: import + replace regex lokal baris 476 + tambah strip prefix `^[^:]+:\s*\n?\s*/i` sebelum test (baris 479), sehingga ^ anchor bekerja di grup Telegram
- **Python identity.py**: tambah `apa uang bisa kamu (lakukan|bantu|buat)` ke `SELF_REF_RE` (baris 22).
- **Test regex**: `apa uang bisa kamu lakukan` → `true` (dulu `false`); `apa yang bisa kamu lakukan` → `true` (masih works); `what can you do` → `true`; `siapa kamu` → `true`.

- **Cleanup sessi (audit-driven) DONE di source local** — menunggu deploy:
  - **DEPLOYED ⚡ 2026-09-08** → Version `d31fc49f-4d65-4789-83e9-2656df83d449` live di `jarvis-sovereign.vikricahya64.workers.dev`; healthz OK (200), 5 cron terjaga. Queue consumer `jarvis-tasks` yang lama dilepas dari worker (blokir deploy karena handler `queue()` dihapus).
  - Sekret: bot token di SUMMARY + PAT remote dicabut (harus revoke di sisi pemilik; token sudah ditandai revoked).
  - Dead code CF dihapus + `queue()`/task_processor dibuang (queue binding nonaktif); typecheck clean.
  - `BUG_PATTERNS` single-source di identity.ts.
  - `acquireCronLock` fail-closed; self-healing loops jujur (recovery/deploy/config advisory-only).
  - Auth fail-closed: orchestrator & simulator_proxy → `INTERNAL_AUTH_TOKEN`; cron & maintenance → `CRON_SECRET`; `self_repair` tanpa shell.
  - `.vercelignore` + fly_app.py → 12 fungsi; Dockerfile CMD → fly_app:app.
  - Verifikasi: `tsc --noEmit` ✓, logic/safety tests ✓, py_compile ✓.

### In Progress
- **Debug sisa bug "uang"**: Konteks memori menunjukkan user mengulang "apa uang bisa kamu lakukan" 4x (13:25, 14:31, 14:44, 14:52). Setiap kali typenya "uang" (typo dari "yang"), sebelum fix regex tidak match → lolos ke `act()` → `extractTopic` → topic "uang bisa kamu lakukan" → LLM menjawab tentang uang. Setelah fix regex dan guard berlapis, input "apa uang bisa kamu lakukan" kini tertangkap di semua jalur (webhook, cognition, python) dan akan return `selfRefReply` tanpa menelusuri search.

### Blocked
- Belum perlu (semua jalur sudah dilapisi guard self-ref).

## Key Decisions
- Self-ref harus dijawab hardcoded dari identitas (tanpa LLM) — guard berlapis di webhook, `llmRespond` (cognition), `searchAndSynthesize`, dan kini juga di `telegram_webhook.ts` dan `utils/identity.py` (Python).
- Bot utama = CF worker; perbaikan Python/Vercel tetap diteruskan karena sistem paralel bisa melayani task via cron/pipeline.
- Vercel `builds` + `functions` tidak bisa dipakai bersamaan; `.vercelignore` exclusion (`api/fly_app.py`) adalah cara aman mengurangi fungsi, bukan `builds`.
- Regex `^` anchor butuh prefix strip sebelum test — standarisasi dengan `normalizeInput.replace(/^[^:]+:\s*\n?\s*/i, "")` agar both private chat dan group chat work.
- "uang" → "yang" typo diekspor ke semua module sebagai single point maintenance.

## Next Steps
1. **Pemilik (WAJIB, keamanan):** revoke bot Token `TELEGRAM_TOKEN_REDACTED` @BotFather dan PAT GitHub yang pernah bocor; buat token baru & set `TELEGRAM_TOKEN` via wrangler secret.
2. **Pemilik (Vercel):** pastikan `INTERNAL_AUTH_TOKEN` & `CRON_SECRET` sudah ter-set di project (endpoint kini fail-closed — 401 tanpa header); update header `Authorization` di Supabase webhook.
3. ~~Deploy CF~~ **DONE ⚡ Version `d31fc49f-4d65-4789-83e9-2656df83d449`**, healthz OK, cron 5 terjaga (2026-09-08).
4. ~~Deploy Vercel ulang~~ **DONE ✅** prod alias `jarvis-sigma-navy-gamma.vercel.app`; `/api/health` 200; `/api/orchestrator` 401 tanpa token (auth aktif); deploy 12 fungsi OK (2026-09-08).
5. **Monitoring** (owner): `getWebhookInfo` periodic check untuk `last_error_date` & `pending_update_count`.

## Critical Context
- Deploy CF terakhir live: `9b11d1f8` — revisi lokal (cleanup, lihat Progress) menunggu deploy berikutnya.
- Supreme Orchestrator/DI/Module Contract/Context Sanitizer/loop_scheduler/task_processor DIHAPUS (dead code, queue binding nonaktif). Routing tunggal di `telegram_webhook.ts` + cron langsung di `index.ts`.
- /debug_bypass command masih ada di telegram_webhook (admin-only, 5min TTL).
- Self-healing loops (recovery/deploy/config) kini HONEST: tidak mengklaim fix yang tidak terjadi; fail-closed di lock & auth.
- Sekret: bot token + PAT yang pernah bocor di versi lama SUDAH di-revoke pemilik — jangan commit ulang token ke repo.

## Relevant Files (updated)
- `/workspace/jarvis/cf/src/index.ts`: entry worker; queue handler dihapus; `/healthz`, `/webhook`, `/setwebhook`, `/setup`, `/status`, `/debug`, cron dispatch
- `/workspace/jarvis/cf/src/lib/identity.ts`: `SELF_REF_RE` + `BUG_PATTERNS` (single source of truth)
- `/workspace/jarvis/cf/src/lib/resilience.ts`: `acquireCronLock` fail-closed
- `/workspace/jarvis/cf/src/lib/recovery_loop.ts` / `deploy_safety.ts` / `config_optimizer.ts`: advisory-only (tanpa teater)
- `/workspace/jarvis/cf/src/lib/evolution.ts` / `predictive.ts`: pakai `BUG_PATTERNS` dari identity.ts
- `/workspace/jarvis/cf/src/lib/error_monitor.ts`: model `openai/gpt-oss-120b` VALID di Groq (GroqDocs) — dibiarkan
- `/workspace/jarvis/api/orchestrator.py` / `simulator_proxy.py`: wajib `INTERNAL_AUTH_TOKEN` (fail-closed, 401)
- `/workspace/jarvis/api/cron.py` / `maintenance.py`: wajib `CRON_SECRET` (fail-closed, 401)
- `/workspace/jarvis/utils/self_repair.py`: test lokal no-shell (tanpa `shell=True`), binary allowlist
- `/workspace/jarvis/.vercelignore`: tambah `api/fly_app.py` → 12 fungsi (cap Hobby)
- `/workspace/jarvis/Dockerfile`: CMD `uvicorn api.fly_app:app` (bukan webhook:app)
- `/workspace/jarvis/utils/identity.py`: Python "uang" variant for Vercel parity