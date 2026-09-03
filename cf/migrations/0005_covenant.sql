-- =====================================================================
-- J.A.R.V.I.S. Level 12 — D1 schema migration (0005_covenant.sql)
-- Transcendent Steward: Immutable Covenant + Identity Anchor + Quota +
-- Sunset conditions (preview-only). R2/IPFS intentionally NOT used (card).
--
-- Covenant immutability is enforced at the DATABASE layer (trigger), so the
-- AI can read clauses but can never UPDATE/DELETE them. Writes go through
-- INSERT-only helpers in cf/src/lib/covenant_core.ts.
-- =====================================================================

-- Immutable covenant ledger. APPEND-ONLY via trigger; versioned per id.
CREATE TABLE IF NOT EXISTS covenant_clauses (
    id         TEXT PRIMARY KEY,
    version    INTEGER NOT NULL DEFAULT 1,
    content_hash TEXT NOT NULL DEFAULT '',   -- SHA-256 (hex) of clause text
    signed_by_user INTEGER NOT NULL DEFAULT 0, -- 0 = draft, 1 = owner-signed
    signed_at  INTEGER NOT NULL DEFAULT 0,     -- unix ms
    is_active  INTEGER NOT NULL DEFAULT 0,     -- 1 = current binding clause
    created_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE (id, version)
);
CREATE INDEX IF NOT EXISTS idx_cov_active ON covenant_clauses(is_active);

-- Database-level immutability: prevent ANY update/delete of covenant rows.
-- Signing a new version INSERTS a new row (and a separate INSERT toggles the
-- old row's is_active via a NEWER row, never an UPDATE — handled in ts).
DROP TRIGGER IF EXISTS prevent_covenant_modification;
CREATE TRIGGER prevent_covenant_modification
BEFORE UPDATE OR DELETE ON covenant_clauses
BEGIN
    SELECT RAISE(ABORT, 'Covenant is immutable');
END;

-- Temporal identity anchor: hash-chain of system config across time.
CREATE TABLE IF NOT EXISTS identity_epochs (
    epoch_id     TEXT PRIMARY KEY,      -- SHA-256(config_hash + prev + ts)
    config_hash  TEXT NOT NULL DEFAULT '',
    previous_epoch_hash TEXT,           -- NULL for genesis
    covenant_hash TEXT NOT NULL DEFAULT '',  -- active covenant hash bound in
    timestamp    INTEGER NOT NULL DEFAULT 0,
    verified     INTEGER NOT NULL DEFAULT 0
);

-- Quota metrics snapshot for Graceful Degradation (updated hourly).
CREATE TABLE IF NOT EXISTS quota_metrics (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             INTEGER NOT NULL,    -- unix ms
    req_used       INTEGER NOT NULL DEFAULT 0,
    remaining_pct  REAL NOT NULL DEFAULT 100,
    degraded_features TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_qm_time ON quota_metrics(ts DESC);

-- Sunset conditions (evaluation state, prefetched latch for preview).
CREATE TABLE IF NOT EXISTS sunset_conditions (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    met        INTEGER NOT NULL DEFAULT 0,   -- 1 = condition currently true
    last_checked_at INTEGER NOT NULL DEFAULT 0,
    detail     TEXT NOT NULL DEFAULT ''
);