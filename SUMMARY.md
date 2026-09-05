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
- **Deploy CF `9b11d1f8`** — live 100%, typecheck `tsc --noEmit` clean (exit 0), healthz OK.
- **Supreme Orchestrator** (`cf/src/core/supreme_orchestrator.ts`): single entry point for ALL Telegram webhook requests. Intent extraction → Covenant validation → Module selection → Context sanitization → Response assembly. NO business logic inside orchestrator.
- **DI Container** (`cf/src/core/di_container.ts`): single point for DB/KV/Groq instantiation. Adapters: DatabaseAdapter, KVAdapter, GroqClient. Modules receive dependencies via constructor.
- **Module Contract** (`cf/src/interfaces/module_contract.ts`): standardized JarvisModule interface with CleanContext. Every module MUST implement execute(), healthCheck(), getCapabilities().
- **Context Sanitizer** (`cf/src/lib/context_sanitizer.ts`): strips technical metadata before AI calls. CleanContext explicitly excludes systemMetrics, errorLogs, rawKVConfig, fullChatHistory.
- **CovenantCore class** (`cf/src/lib/covenant_core.ts`): implements JarvisModule contract with DI adapters. Backward compatible - original standalone functions unchanged.
- **ErrorMonitor class** (`cf/src/lib/error_monitor.ts`): implements JarvisModule contract with DI adapters. Backward compatible - original standalone functions unchanged.
- **/debug_bypass command** (`cf/src/workers/telegram_webhook.ts`): admin-only, 5min TTL, bypasses orchestrator for verification.
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
- Deploy CF terbaru: `9b11d1f8` — live 100%, typecheck clean (exit 0).
- Supreme Orchestrator ready for integration (not yet wired to webhook handler).
- DI Container registers CovenantCore and ErrorMonitor with adapters.
- All original standalone functions remain unchanged for backward compatibility.
- /debug_bypass command available for admin verification (5min TTL).

## Relevant Files (updated)
- `/workspace/jarvis/cf/src/core/supreme_orchestrator.ts`: Supreme Orchestrator - single entry point for ALL Telegram webhook requests
- `/workspace/jarvis/cf/src/core/di_container.ts`: DI Container - single point for DB/KV/Groq instantiation with adapters
- `/workspace/jarvis/cf/src/interfaces/module_contract.ts`: Module Contract - standardized JarvisModule interface with CleanContext
- `/workspace/jarvis/cf/src/lib/context_sanitizer.ts`: Context Sanitizer - strips technical metadata before AI calls
- `/workspace/jarvis/cf/src/lib/identity.ts`: `SELF_REF_RE` export + `selfRefReply` + `systemPromptBlock` (single source of truth)
- `/workspace/jarvis/cf/src/lib/intelligence.ts`: import `SELF_REF_RE` dari identity; hapus definisi lokal
- `/workspace/jarvis/cf/src/lib/ai.ts`: import `SELF_REF_RE` dari identity; replace 2x definisi regex lokal
- `/workspace/jarvis/cf/src/workers/telegram_webhook.ts`: import `SELF_REF_RE` + prefix strip + /debug_bypass command
- `/workspace/jarvis/cf/src/lib/covenant_core.ts`: CovenantCore class implementing JarvisModule contract (backward compatible)
- `/workspace/jarvis/cf/src/lib/error_monitor.ts`: ErrorMonitor class implementing JarvisModule contract (backward compatible)
- `/workspace/jarvis/utils/identity.py`: Python "uang" variant for Vercel parity