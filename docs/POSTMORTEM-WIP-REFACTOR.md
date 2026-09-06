# POSTMORTEM — Refactor WIP yang Gagal (Supreme Orchestrator & Module Contract)

**Status:** Ditutup sebagai dokumentasi kegagalan, bukan diimplementasikan.
**Tanggal analisis:** 2026-09-06
**Ruang lingkup:** `cf/` (Cloudflare Worker `jarvis-sovereign`, database D1).

---

## 1. Ringkasan Eksekutif

Dua commit di cabang `main` mencoba mengubah arsitektur Cloudflare Worker dari "function berlapis"
menjadi "Supreme Orchestrator + DI Container + Module Contract". Commit tersebut **tidak pernah
di-deploy** dan **tidak pernah lolos typecheck**, karena meng-import modul yang **tidak pernah ada
di history git** dan menambahkan file-file yang meng-import modul yang juga tidak ada.

Akibatnya di repo `main` terdapat **61 error TypeScript** (`tsc --noEmit` non-zero). Sementara itu
**worker live `jarvis-sovereign` (version `7b188158`) tetap sehat** karena dibangun dari source tree
asal yang berbeda dan lebih lengkap — bukan dari repo `main` yang parsial ini.

Keputusan: **repo `main` tidak diselaraskan ulang ke live, dan refactor WIP dijadikan dokumen ini
saja.** Sistem live berjalan normal di lingkungan 100% gratis (Cloudflare + Vercel + Supabase + E2B).

---

## 2. Apa yang Dicoba Dilakukan

Dua commit utama:

| Commit | Pesan | Isi |
|---|---|---|
| `badf46d` | `feat: add Supreme Orchestrator, DI Container, Module Contract, Context Sanitizer` | Menambah 4 file baru: `core/supreme_orchestrator.ts`, `core/di_container.ts`, `interfaces/module_contract.ts`, `lib/context_sanitizer.ts` |
| `2e8f747` | `refactor: SELF_REF_RE centralized + module contract scaffolding` | Merombak 5 file: `ai.ts`, `covenant_core.ts`, `error_monitor.ts`, `intelligence.ts`, `telegram_webhook.ts` (+2117 baris) |

Pesan commit **mengklaim**: *"All files compile cleanly (tsc --noEmit exit 0)"* dan
*"Typecheck clean, backward compatible"* — namun **faktanya tidak benar** (lihat §4).

Arsitektur yang dituju:

```
Telegram → Supreme Orchestrator
            ├─ Intent extraction (SELF_REF_RE + detectIntent)
            ├─ Covenant / compliance validation
            ├─ Context sanitization (CleanContext)
            ├─ Module selection via DI Container
            ├─ Sequential execution (JarvisModule.execute)
            └─ Response assembly dengan fallback
```

---

## 3. Kenapa Gagal — Akar Masalah

### 3.1 Modul yang di-import tidak pernah ada di history git

Refactor `2e8f747` membuat file-file berubah meng-import modul yang **tidak pernah ada** di seluruh
history git (`git rev-list --all --objects` kosong):

| Modul yang di-import (tidak ada) | Dipakai oleh |
|---|---|
| `lib/jarvis_core.ts` (`MessageContext`, `JarvisResponse`, `detectIntent`, `processMessage`) | `telegram_webhook.ts`, `intelligence.ts`, `supreme_orchestrator.ts` |
| `lib/messages.ts` (`getGreeting`, `ERRORS`, `STATUS`, `SEARCH`, `SUGGESTIONS`, `HELP`) | `telegram_webhook.ts` |
| `lib/deploy_safety.ts` (`getActiveVersion`) | `error_monitor.ts` |
| `lib/jarvis_language.ts` (`detectLanguage`, `Language`) | `intelligence.ts` |
| Ekspor lain yang belum ada: `emotion.updateMood/getMoodState/moodSummary/MoodState`, `subagents.isDesignIntent/orchestrateDesign`, `db.lowStockProducts/customers/orders/salesReport`, `context_manager.saveSessionToKV/loadSessionFromKV` | `intelligence.ts`, `ai.ts`, `telegram_webhook.ts` |

File-file yang baru ditambahkan di `badf46d` (supreme_orchestrator dkk.) juga meng-import
`jarvis_core` yang sama-sama tidak ada.

### 3.2 Ada DUA source tree yang berbeda

Bukti dari worker live:

- Bundle source live (diunduh via CF API, 314 KB / ~8600 baris) **memuat 37 modul**, termasuk
  7 modul yang tidak ada di repo `main`: `jarvis_core.ts`, `messages.ts`, `deploy_safety.ts`,
  `jarvis_language.ts`, `config_optimizer.ts`, `recovery_loop.ts`, `weather.ts`.
- Bundel live **tidak memuat** 4 file yang di-add `badf46d` (`supreme_orchestrator`,
  `di_container`, `module_contract`, `context_sanitizer`). Artinya refactor tersebut
  **tidak pernah di-deploy**.
- `version: "7b188158"` di `/healthz` adalah nilai **hardcoded** di bundel live — bukan nilai
  dari repo `main` mana pun.

**Akar masalah:** commit `badf46d`/`2e8f747` = percobaan desain ulang yang dibuat di atas repo
parsial, sedangkan sistem yang benar-benar berjalan dibangun dari **source tree lain yang lebih
lengkap** (mesin lokal/deploy langsung via Wrangler). Keduanya menyimpang; repo `main` tidak bisa
merepresentasikan live, dan sebaliknya.

### 3.3 Tidak ada guardrail deployment

Alur deploy otomatis (`.github/workflows/deploy.yml`) menjalankan `npm run typecheck` dan
`test:safety` **sebelum** `wrangler deploy`. Jika commit WIP ini masuk ke `main` dan workflow
berjalan, typecheck akan **menahan deploy**. Kondisi ini tidak terjadi karena deploy live dilakukan
manual via Wrangler dari source tree lain, sehingga kesalahan ini tidak ter-trigger oleh CI.

---

## 4. Dampak Terukur

- **Typecheck `cf/`** → **61 error** (sebelum `2e8f747`, di commit `0b4ed1a`, typecheck **bersih 0 error**).
  Rincian:
  - `src/workers/telegram_webhook.ts` — 40
  - `src/lib/intelligence.ts` — 9
  - `src/lib/ai.ts` — 9
  - `src/core/supreme_orchestrator.ts` — 2
  - `src/lib/error_monitor.ts` — 1
- **Deploy GitHub Actions** → akan GAGAL pada step typecheck (jika dipicu).
- **Worker live** → **tidak terpengaruh**. `/healthz` → `{"ok":true,"env":"production","version":"7b188158"}`.
  Rute `/status`, `/webhook`, `/setwebhook`, `/ai_diag`, `/audit_status` berfungsi.

---

## 5. Bagaimana JARVIS SEKARANG Benar-Benar Berjalan

Sistem live berjalan **hibrida 4 komponen**, semuanya 100% free-tier:

```
Telegram (User)
   ├──▶ [Cloudflare Worker] jarvis-sovereign (D1 + KV + Groq + AI)
   │       - /webhook  = entry Telegram (verifikasi secret token, idempotency via KV)
   │       - /healthz  = {ok, env, version}
   │       - /status, /audit_status, /setwebhook (privilege-gated)
   │       - Kron: DMS, value alignment, obedience report (≤4 trigger, kuota free 5)
   │       - D1      = database SQLite (aktivitas, DMS, covenant, error, request_log)
   │       - KV      = idempotency, config, cert
   │       - Queue   = dinonaktifkan sementara (token CF tidak punya Queues:Edit)
   └──▶ [Vercel/Python] jarvis-sigma-navy.vercel.app (backstop/paralel)
           - api/webhook.py → Supabase tasks → api/orchestrator.py → Groq tool-calling
           - Builder → E2B sandbox → Supabase Storage → balas ke Telegram
           - /api/health → supabase=up, groq=up, telegram=up, e2b=available

Komponen pendukung:
   - Supabase   : tabel tasks + Storage (artefak) + DB webhook
   - E2B        : sandbox eksekusi kode (free tier)
   - Groq       : LLM tool-calling (free tier)
```

Status kesehatan terverifikasi (2026-09-06):

| Komponen | Status |
|---|---|
| Cloudflare Worker `/healthz` | ✅ `{ok, env:production, version:7b188158}` |
| Vercel `/api/health` | ✅ `{overall:ok, supabase:up, groq:up, telegram:up, e2b:available}` |
| Supabase | ✅ up |
| E2B | ✅ available |
| Fly.io (`jarvis-ubiquitous`) | ⚠️ tidak aktif (di luar jalur utama) |

---

## 6. Pelajaran & Aturan ke Depan (Anti-Regresi)

1. **Satu sumber kebenaran per sistem.** Jangan membangun refactor di atas repo yang parsial.
   Jika live di-deploy manual dari mesin, komit **dulu** file sumber yang konsisten ke git sebelum
   mengubah arsitektur, atau tarik dulu source live ke repo.
2. **`tsc --noEmit` wajib zero sebelum commit.** Setiap PR/commit yang menyentuh `cf/` harus lolos
   `npm run typecheck` + `npm run test:safety`. Klaim "typecheck clean" di pesan commit harus
   diverifikasi, bukan diandalkan.
3. **Impor vs ketersediaan modul wajib diperiksa.** Tambahkan guard statis (mis. script)
   yang memastikan semua `import ... from "./xxx"` ada file-nya dan semua ekspor yang dipakai
   ter-ekspor.
4. **Guardrail deploy (CI) adalah garis pertahanan terakhir.** Jangan pernah bypass
   typecheck/safety test untuk mempercepat deploy manual.
5. **Mekanisme versi:** `version` di `/healthz` adalah nilai hardcoded di bundel live. Untuk
   auditibilitas, versi sebaiknya diambil dari sumber deterministik (mis. hash dari git yang
   ter-deploy), bukan string literal yang bisa tertinggal.
6. **Dokumentasi arsitektur:** file ini adalah referensi "kenapa refactor ini tidak dipakai".
   Jangan mengimplementasikan `supreme_orchestrator`/`di_container`/`module_contract`/
   `context_sanitizer` atas dasar commit `badf46d`/`2e8f747` — gunakan postmortem ini sebagai
   konteks sebelum mengulang desain.

---

## 7. Lampiran

- Commit pelaku: `badf46d`, `2e8f747`.
- Titik bersih terakhir di repo: `0b4ed1a` (typecheck 0 error).
- File milik refactor yang tidak pernah deploy: `cf/src/core/supreme_orchestrator.ts`,
  `cf/src/core/di_container.ts`, `cf/src/interfaces/module_contract.ts`,
  `cf/src/lib/context_sanitizer.ts`.
- Modul ada di live tapi tidak di repo: `jarvis_core`, `messages`, `deploy_safety`,
  `jarvis_language`, `config_optimizer`, `recovery_loop`, `weather`.