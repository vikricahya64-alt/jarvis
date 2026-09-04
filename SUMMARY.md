# JARVIS Self-Referential Bug Anchored Summary

## Goal
Perbaiki jawaban self-referential JARVIS ("apa yang bisa kamu lakukan") yang masih mengarang tentang uang, dengan identitas sebagai single source of truth dan guard berlapis di semua jalur eksekusi.

## Constraints & Preferences
- Free-tier permanen: CF Worker 100k req/hari; Vercel Hobby max 12 serverless functions/deployment
- Kedaulatan pemilik; guard fail-closed; balas Bahasa Indonesia; wajib typecheck/deploy/healthz
- Token CF: `export CLOUDFLARE_API_TOKEN=$(grep -oP '^CLOUDFLARE_API_TOKEN=\K.*' /tmp/.cf_token)`; pakai `npx wrangler`
- Bot @VikriJarvisBot → CF worker (webhook live), Vercel Python adalah backstop/paralel
- Token bot tersimpan di `~/.codex/telegram-bridge.json`: `8762708956:AAHKS1LoVWP07uyl0DeT4kV61HOfXKIzppY`
- Jangan deleteWebhook (bot aktif); set webhook secret header via `TELEGRAM_SECRET` (wrangler secret)

## Progress

### Done
- **Guard self-ref cognition-level di CF** (`cf/src/lib/ai.ts`): intercept di `llmRespond()` paling atas (sebelum provider) + guard `searchAndSynthesize()`; return `JARVIS_IDENTITY.selfRefReply` tanpa panggil LLM eksternal. Source type diperluas jadi include `"self_ref"`.
- **Deploy CF `f53eae2c`** (14:50:25Z) — live 100%, typecheck `tsc --noEmit` clean, healthz OK.
- **Identifikasi platform asli**: `getWebhookInfo` → url `https://jarvis-sovereign.vikricahya64.workers.dev/webhook` (CF), BUKAN Vercel/Fly.
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
1. **Deploy CF terkini** setelah semua change (`identity.ts` export, import di 3 file, webhook prefix strip) — `npx wrangler publish`; lalu `npx tsc --noEmit` dan healthz check.
2. **Verifikasi deploy Vercel** masih sukses di `jarvis-sigma-navy.vercel.app`; konfirmasi `/api/webhook` return `{"ok":false,"error":"Invalid signature"}` (aman, bukan crash).
3. **Jalankan ulang test manual** dengan POST berbagai kalimat: "apa uang bisa kamu lakukan", "apa yang bisa kamu lakukan", "siapa kamu", "what can you do" — semua seharusnya return `selfRefReply` tentang kemampuan JARVIS, BUKAN tentang uang.
4. **Monitoring**: aktifkan `getWebhookInfo` periodic check untuk `last_error_date` dan `pending_update_count`.

## Critical Context
- `getWebhookInfo`: url = CF worker, `pending_update_count: 0`, `last_error_date: 1788499507` (05:25:07Z) = "Read timeout expired" (versi lama, sebelum fix).
- Deploy CF terbaru: `f53eae2c` 14:50:25Z (100%). Deployments list diurut oldest-first; index 9 = latest.
- D1 `memories` schema: id, type, content, tags, importance, source, created_at, expires_at, last_retrieved, access_count. Memori self-ref terekam 13:25, 14:31, 14:44, 14:52 dengan topic "uang bisa kamu lakukan" — membuktikan jalur search masih dieksekusi pasca-fix (sebelum guard berlapis di semua jalur).
- D1 `conversation_log` schema: id, owner_id, ts, role, content, search_used.
- `request_log` hanya mencatat provider/DDG (bukan webhook); masih memory "penurunan mata uang rupiah", "bisnis uang besar", "uang" di context sebelumnya — kemungkinan konteks mencemari extractTopic.
- Semua 4 kali ulang user (13:25, 14:31, 14:44, 14:52) ketik "apa uang bisa kamu lakukan" — typo "uang" untuk "yang", konsisten menjebak LLM ke answer uang.
- Simulasi POST ke CF worker tanpa secret → `unauthorized` (benar, `TELEGRAM_SECRET` active).
- Vercel production live: `jarvis-sigma-navy.vercel.app`; script test direct ke deployment URL kena `vercel_auth_enabled` (401 protected).

## Relevant Files (updated)
- `/workspace/jarvis/cf/src/lib/identity.ts`: `SELF_REF_RE` export + `selfRefReply` + `systemPromptBlock` (single source of truth, termodsifikasi untuk include `"self_ref"`)
- `/workspace/jarvis/cf/src/lib/intelligence.ts`: import `SELF_REF_RE` dari identity; hapus definisi lokal; gunakan di `perceive` phase (`baris 193`)
- `/workspace/jarvis/cf/src/lib/ai.ts`: import `SELF_REF_RE` dari identity; replace 2x definisi regex lokal di `llmRespond` (383) dan `searchAndSynthesize` (578)
- `/workspace/jarvis/cf/src/workers/telegram_webhook.ts`: import `SELF_REF_RE` dari identity; replace regex lokal baris 476; tambah `const cleaned = trimmed.replace(/^[^:]+:\s*\n?\s*/i, "").trim()` baris 479 untuk strip prefix grup Telegram sebelum test `^` anchor
- `/workspace/jarvis/utils/identity.py` (Python): tambah `r"apa uang bisa kamu (lakukan|bantu|buat)"` ke `SELF_REF_RE` (baris 22); `SYSTEM_PROMPT_IDENTITY_BLOCK` tetap memasukkan identitas ke system prompt LLM
- `/workspace/jarvis/cf/src/workers/telegram_webhook.ts:473-479`: self-ref handler menggunakan `SELF_REF_RE.test(cleaned)` setelah strip prefix — both private chat (`"Apa uang bisa kamu lakukan"`) dan group chat (`"Vsco Bayu:Apa uang bisa kamu lakukan"`) work.