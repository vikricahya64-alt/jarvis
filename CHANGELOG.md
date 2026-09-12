# Changelog

Semua perubahan penting pada proyek ini dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/)
dan proyek mematuhi [Semantic Versioning](https://semver.org/).
Bahasa: Bahasa Indonesia.

## [Unreleased]

### Added (sesi `review/fixes-2026-09-12`)

- **CI lengkap** (`.github/workflows/ci.yml`): push ke main + PR apa pun
  dijalankan `npm ci → typecheck → test:safety → test:logic` lalu
  `wrangler deploy --dry-run` tanpa secret & tanpa menyentuh Cloudflare.
- **Deploy otomatis** (`deploy.yml`): trigger `push` ke `main` (sebelumnya
  `workflow_dispatch` manual); gate sama seperti CI ditambah `test:logic`.
- **SSOT Python/Vercel**: `api/` (19 modul) & `utils/` (56 modul) dari
  sumber live disalin ke repo — HEAD kini satu-satunya sumber kebenaran
  untuk sisi Python; `vercel.json`, `Dockerfile`, `requirements.txt`,
  `.env.example` (placeholder) & `.vercelignore` disertakan.
- **Keamanan**: scrubbing history via `git-filter-repo` (token bot yang
  pernah terlanjur tercatat di `SUMMARY.md` dihapus total — grep `AAHKS`/
  `8762708956` = 0), `SECURITY.md`, PR template, catatan keamanan di README.
- **Legal & dok**: `LICENSE` (MIT 2026), `CHANGELOG.md` (file ini).

### Changed

- `deploy.yml`: SAFETY GATE diperbarui — repo authoritative, tetap tanpa
  langkah migrasi D1 (dilakukan live oleh pemilik).
- `.gitignore`: `!.env.example` di luar pola `.env*`.

## [v11.2x] – Cascade m9/v11 (pra-repositori-penuh)

Dipangkas dari 273 komit. Riwayat lengkap: `git log`.

- v11.29 — polish output perintah diagnostik (typo, antrean terbaca).
- v11.28 — alias perintah tanpa underscore + catch unknown-command deterministik.
- v11.27 — recall reply selalu berisi konten nyata (hapus stub acknowledge).
- v11.26 — tangkap pertanyaan menu tanpa kata ganti orang pertama.
- v11.25 — perbaikan echo ganda + dedupe memori.
- v11.24 — NVIDIA NIM free-tier masuk kaskade LLM.
- v11.22/11.23 — purge kode mati; rail "door prose" untuk output research/search.
- v11.20/11.21 — kerangka dua paragraf global + "dua pintu" (input terjemah / output natural).
- v11.19 — no-menu guard deterministik tanpa menu.
- v11.18 — `/status` menampilkan probe provider live (🟢/🔴).
- v11.16 → v11.17 — idempotensi cron, lock antrean, jurnal proses oracle.
- v11.0 — arsitektur ulang ke *single-spine* di Cloudflare Worker (5 cron).

## [v10.x] — era pra-single-spine (Fly/Vercel Python)

- Sisi Python (Vercel): `api/`, `utils/` monolit diperluas menjadi modul
  (orchestrator, swarm coordinator, oauth2, multimodal webhook, dst.).
- Fitur yang dihasilkan dari sana (tugas VM, figma/notion connector, DMS)
  kini dijalankan langsung dari worker.

## [v0.x] — asal proyek (`J.A.R.V.I.S.`)

- Bot Telegram pribadi, free-tier penuh; sesi awal di dokumentasikan via
  `SUMMARY.md` & `data/personal_constitutional.md`.