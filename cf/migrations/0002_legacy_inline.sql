-- =====================================================================
-- J.A.R.V.I.S. Level 10/11 — D1 schema migration (0002_legacy_inline.sql)
-- Legacy vault payload migrated INLINE into D1.
--
-- Rationale: remove the dependency on external object storage (R2).
-- The legacy payload is a SMALL, client-side AES-256-GCM-encrypted blob
-- (instructions/routing for the dead-man's-switch, typically <64KB). D1 has
-- 5GB free and is already the authoritative store, so an external bucket buys
-- nothing for a rarely-written, tiny, pre-encrypted payload. Storing it inline
-- keeps the stack 100% free and eliminates the R2 activation/setup step.
--
-- Security: encrypted_blob holds ONLY ciphertext (sealed client-side). The key
-- never touches D1. integrity against tampering is the sha256 column. On DMS
-- wipe the blob is zeroed in place (single UPDATE, atomic in D1).
-- =====================================================================

-- Add the inline encrypted payload column. NULL-safe for rows written before
-- this migration (they default to '' and are treated as "no payload yet").
ALTER TABLE legacy_vault_metadata ADD COLUMN encrypted_blob TEXT NOT NULL DEFAULT '';