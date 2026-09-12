# Panduan Agen (AGENTS.md) — JARVIS

> Berbahasa Indonesia secara default (kode, komentar, laporan).

## Trunk & branch

- **TRUNK = branch `main`** (lokal ber-fondasi `comprehension.ts` /
  `capability_registry.ts`). DILARANG membangun kerja pada branch
  `refactor/cleanup-2026-09-12` atau base lama m9-v11.29.
- Setiap tugas baru: mulai dari `main`. Buat branch kerja dari `main`,
  selesaikan, lalu gabung kembali ke `main`.
- `origin/main` adalah versi deploy; push perlu persetujuan bila non-
  fast-forward dan dilarang force tanpa izin eksplisit pemilik.

## Fondasi (jangan diubah tanpa alasan yang jelas)

- `cf/src/lib/comprehension.ts` — comprehension root
  (fondasi f1..f7: teks/literasi/bahasa/ilmu/adaptasi sesi + mengerti &
  menggunakan SEMUA kemampuan).
- `cf/src/lib/capability_registry.ts` — kontrak kemampuan
  (`ALL_FOUNDATIONS`, `testFoundationAnchoring`).
- Tingkatkan `capability_registry` (kontrak) bila menambah kemampuan —
  JANGAN buat registri paralel.

## Aturan keras

- **Jangan commit secret** (pola token bot `8762…`/`AAHK…`, `ghp_`, `sk-`,
  isi `.env*`; `git grep` pola tersebut HARUS = 0 saat selesai).
- Fail-closed; free-tier permanen (bounded CPU/timeouts, kaskade provider).
- Verifikasi wajib sebelum selesai:
  - `cd cf && npm run typecheck`
  - `cd cf && npm run test:safety`
  - `cd cf && npm run test:logic`
  - `git grep -nE 'AAHKS|8762708956' -- ':!cf/node_modules'` hasil 0
  - `git status --short` bersih
- Jangan ubah binding `wrangler.toml`, migrasi D1, kontrak URL worker↔
  workflow, `artifacts/` dan `data/personal_constitutional.md` tanpa
  persetujuan.

## Lokasi penting

- `cf/` — Cloudflare Worker (kode utama); script npm: dev / typecheck /
  test:safety / test:logic / db:migrate.
- `api/` + `utils/` — sisi Python (Vercel) SSOT di repo.
- `.github/workflows/` — CI (gerbang), deploy (push ke main), autonomy,
  jarvis-delegate + opencode (pekerjaan VM).
- `data/personal_constitutional.md` — konstitusi kepemilikan (jangan
  diedit).

## Alur kerja aman

1. Mulai dari `main` terbaru; buat branch `fix/…` / `feat/…`.
2. Kerjakan + uji lokal (typecheck, safety, logic).
3. `git status --short` bersih tanpa secret; grep pola token = 0.
4. Push branch; jangan force-push tanpa izin. Hapus branch lama hanya
   setelah backup & persetujuan pemilik.