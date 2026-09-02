-- =====================================================================
-- J.A.R.V.I.S. Level 10/11 — D1 schema migration (0001_init.sql)
-- D1 = SQLite at the edge (Cloudflare). Free: 5GB, 100k reads/day.
--
-- Residency/sovereignty notes:
--   * No plaintext secrets. Legacy payloads live in R2 (client-side
--     AES-256-GCM); this table stores only metadata + integrity checks.
--   * obedience_audit is APPEND-ONLY at the application layer (no
--     UPDATE/DELETE paths exposed; see lib/command_hierarchy.ts).
--   * dms_state is the authoritative DMS state machine; every transition
--     is a guarded single-statement UPDATE (atomic in D1).
--   * All timestamps are unix epoch ms (INTEGER) for cheap range queries.
-- =====================================================================

-- Track last human interaction (heartbeat resets it on any command).
CREATE TABLE IF NOT EXISTS user_activity (
    owner_id          INTEGER PRIMARY KEY,
    last_interaction  INTEGER NOT NULL DEFAULT 0,   -- unix ms
    last_heartbeat    INTEGER NOT NULL DEFAULT 0,   -- unix ms (daemon/edge)
    source            TEXT    NOT NULL DEFAULT 'telegram', -- telegram|edge|email
    updated_at        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_user_activity_time ON user_activity(last_interaction);
CREATE INDEX IF NOT EXISTS idx_user_activity_heartbeat ON user_activity(last_heartbeat);

-- Immutable obedience audit (append-only by policy in application layer).
CREATE TABLE IF NOT EXISTS obedience_audit (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id         INTEGER NOT NULL,
    ts               INTEGER NOT NULL,              -- unix ms
    action_type      TEXT NOT NULL,                 -- USER_COMMAND|AUTONOMOUS_ACTION|CONSENT_REQUEST|EMERGENCY_OVERRIDE
    user_command_hash TEXT NOT NULL DEFAULT '',
    priority         INTEGER NOT NULL DEFAULT 0,    -- 100/90/70/50/30
    decision         TEXT NOT NULL DEFAULT '',      -- EXECUTE|BLOCK|DEFER|CLARIFY|CONSENT
    compliance       TEXT NOT NULL DEFAULT '',      -- COMPLIANT|BLOCKED|PENDING
    blocking_source  TEXT NOT NULL DEFAULT '',
    evidence_json    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_obedience_time ON obedience_audit(owner_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_obedience_compliance ON obedience_audit(compliance);

-- Consent log (inline-button decisions).
CREATE TABLE IF NOT EXISTS consent_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id         INTEGER NOT NULL,
    correlation_id   TEXT NOT NULL,
    ts               INTEGER NOT NULL,
    action_desc      TEXT NOT NULL DEFAULT '',
    risk_level       TEXT NOT NULL DEFAULT '',     -- low|medium|high
    decision         TEXT NOT NULL DEFAULT '',     -- approve|deny|pause|timeout
    priority         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_consent_corr ON consent_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_consent_owner_time ON consent_log(owner_id, ts DESC);

-- DMS state machine (authoritative).
CREATE TABLE IF NOT EXISTS dms_state (
    owner_id          INTEGER PRIMARY KEY,
    stage             TEXT NOT NULL DEFAULT 'idle',   -- idle|verify|stage2|executed|overridden
    last_heartbeat    INTEGER NOT NULL DEFAULT 0,
    last_interaction  INTEGER NOT NULL DEFAULT 0,
    grace_days        INTEGER NOT NULL DEFAULT 30,
    stage1_at         INTEGER NOT NULL DEFAULT 0,     -- when verification ping sent
    stage2_at         INTEGER NOT NULL DEFAULT 0,     -- when stage2 (48h) armed
    executed_at       INTEGER NOT NULL DEFAULT 0,
    contacts_json     TEXT NOT NULL DEFAULT '[]',     -- [{kind,handle}] low-sensitivity
    config_json       TEXT NOT NULL DEFAULT '{}',
    updated_at        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dms_stage ON dms_state(stage);

-- Legacy vault metadata (payload in R2; keep only pointers + checksum).
CREATE TABLE IF NOT EXISTS legacy_vault_metadata (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id         INTEGER NOT NULL,
    r2_key           TEXT NOT NULL,
    cipher_algo      TEXT NOT NULL DEFAULT 'AES-256-GCM',
    intent           TEXT NOT NULL DEFAULT '',      -- transfer|delete|release|archive|none
    sha256           TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'armed', -- armed|verifying|executed|revoked
    created_at       INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vault_owner ON legacy_vault_metadata(owner_id, status);

-- Interaction log (corrections signal for the value-alignment daemon).
CREATE TABLE IF NOT EXISTS interaction_logs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id         INTEGER NOT NULL,
    ts               INTEGER NOT NULL,
    kind             TEXT NOT NULL,                 -- message|correction|consent|proposal
    intent           TEXT NOT NULL DEFAULT '',
    correction_signal REAL NOT NULL DEFAULT 0,      -- -1..1 (drift detector)
    payload_json     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_ilog_owner_time ON interaction_logs(owner_id, ts DESC);

-- Value alignment proposals (auto-expire after 7 days).
CREATE TABLE IF NOT EXISTS value_proposals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id         INTEGER NOT NULL,
    ts               INTEGER NOT NULL,
    domain           TEXT NOT NULL,
    old_value        TEXT NOT NULL DEFAULT '',
    new_proposal     TEXT NOT NULL DEFAULT '',
    reason           TEXT NOT NULL DEFAULT '',
    confidence       REAL NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'pending', -- pending|confirmed|expired|rejected
    expires_at       INTEGER NOT NULL DEFAULT 0,
    confirmed_at     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vprop_owner_status ON value_proposals(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_vprop_expiry ON value_proposals(expires_at);