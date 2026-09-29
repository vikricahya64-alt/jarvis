-- 0020_memories_owner_scoped.sql
--
-- m9-v11.55 — SCOPE MEMORY PER-USER.
--
-- LATAR: tabel `memories` tidak punya kolom owner_id, sehingga SELURUH memori
-- milik owner. Saat tier "user" (ALLOWED_USER_IDS) diperkenalkan, recall
-- akan menyuntikkan memo pribadi owner ke jawaban user lain (nama, pekerjaan,
-- rencana) — kebocoran data pribadi yang tak bisa ditarik kembali.
--
-- SOLUSI: tambah owner_id, backfill SELURUH baris lama ke owner (memori yang
-- sudah ada pasti milik owner — bot ini single-user sampai m9-v11.55), lalu
-- semua query baca wajib memfilter owner_id.
--
-- CATATAN FTS5: virtual table memories_fts di-backfill otomatis oleh trigger
-- sync yang sudah ada (menyalin rowid), jadi tidak perlu perubahan di sana —
-- cukup filter owner_id di query JOIN.

ALTER TABLE memories ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 0;

-- Backfill: semua memori eksisting = owner. Nilai 0 (default) berarti
-- "memori tanpa pemilik" dan tidak boleh terbaca lewat jalur user mana pun.
UPDATE memories SET owner_id = 6812604983 WHERE owner_id = 0;

-- Index untuk filter owner (recall selalu per-user, selalu lewat owner_id).
CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(owner_id);
