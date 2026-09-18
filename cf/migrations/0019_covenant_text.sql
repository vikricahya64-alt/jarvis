-- =====================================================================
-- J.A.R.V.I.S. — D1 schema migration (0019_covenant_text.sql)
-- Covenant validator kini harus menilai ISI klausa, bukan cuma hash.
--
-- Sebelumnya covenant_clauses hanya menyimpan content_hash, jadi validator
-- Groq "menilai" klausa tanpa pernah melihat teksnya (report 2026-09-18:
-- covenant validator structurally blind). Migrasi ini ADDITIF:
--   * menambah kolom content_text (teks klausa asli saat penandatanganan);
--   * TIDAK mengubah/menetralkan trigger immutabilitas (0005) — masih
--     append-only;
--   * klausa lama tanpa teks tetap back-compat (validator memakai fallback
--     hash, fail-closed terjaga).
-- Catatan: kolom baru di backfill tidak memungkinkan via UPDATE (trigger
-- RAISE(ABORT) melarang UPDATE/DELETE pada covenant_clauses) — klausa lama
-- (mis. "safety-test" hash "abc") dibiarkan apa adanya.
-- =====================================================================

ALTER TABLE covenant_clauses ADD COLUMN content_text TEXT NOT NULL DEFAULT '';