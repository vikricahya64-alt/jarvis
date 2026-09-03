--==============================================================================
-- 0006_resilience.sql — Infrastructure-framework patterns (adopted from public
-- reference research: circuit breaker, observability, FTS5 memory, cron lock).
--
-- All free-tier (D1 only; no R2/Vectorize/DO needed). Mirrors references:
--   * provider_health  -> lazy circuit breaker (LLM resilience)
--   * request_log      -> per-provider observability (AI Gateway parity)
--   * memories / fts   -> D1 native FTS5 BM25 memory retrieval (BrainDB/Hermes)
--   * cron_locks       -> D1 transactional lock for cron overlap prevention
--   * agent_states     -> FSM state persistence for orchestration
--==============================================================================

-- Circuit breaker state per LLM provider (CLOSED/OPEN/HALF_OPEN).
CREATE TABLE IF NOT EXISTS provider_health (
    provider        TEXT PRIMARY KEY,               -- 'groq' | 'gemini'
    state           TEXT NOT NULL DEFAULT 'closed', -- closed|open|half_open
    failures        INTEGER NOT NULL DEFAULT 0,
    last_failure_at INTEGER NOT NULL DEFAULT 0,     -- unix ms
    cooldown_until  INTEGER NOT NULL DEFAULT 0      -- unix ms; 0 = none
);

-- Per-provider LLM call observability (AI Gateway cf-aig-step parity).
CREATE TABLE IF NOT EXISTS request_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,                  -- unix ms
    provider      TEXT NOT NULL,                     -- groq | gemini | ddg
    status        TEXT NOT NULL,                     -- ok | fail
    latency_ms    INTEGER NOT NULL DEFAULT 0,
    step          INTEGER NOT NULL DEFAULT 0,        -- 0=primary,1=fallback,...
    note          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_reqlog_time ON request_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_reqlog_prov ON request_log(provider, status);

-- Episodic/curated memory (source of truth) — FTS5-indexed for retrieval.
CREATE TABLE IF NOT EXISTS memories (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL DEFAULT 'fact',   -- fact|decision|context|person
    content     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',     -- JSON array
    importance  INTEGER NOT NULL DEFAULT 1,     -- 1..5
    source      TEXT NOT NULL DEFAULT 'turn',   -- turn|rollup|owner
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL DEFAULT 0      -- 0 = never
);

-- FTS5 virtual table for BM25 keyword retrieval (content+tags+type).
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, tags, type,
    content='memories', content_rowid='rowid'
);

-- Sync triggers (alerted: FTS5 external content must mirror the base table).
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, tags, type)
    VALUES (new.rowid, new.content, new.tags, new.type);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags, type)
    VALUES ('delete', old.rowid, old.content, old.tags, old.type);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags, type)
    VALUES ('delete', old.rowid, old.content, old.tags, old.type);
    INSERT INTO memories_fts(rowid, content, tags, type)
    VALUES (new.rowid, new.content, new.tags, new.type);
END;

-- D1 transactional lock for cron overlap prevention (KV locks are unsafe here).
CREATE TABLE IF NOT EXISTS cron_locks (
    lock_name   TEXT PRIMARY KEY,
    locked_by   TEXT NOT NULL DEFAULT '',
    locked_at   INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL DEFAULT 0        -- 0 = released
);

-- FSM orchestration state (session-scoped, recovered by cron).
CREATE TABLE IF NOT EXISTS agent_states (
    session_id   TEXT PRIMARY KEY,
    current_state TEXT NOT NULL DEFAULT 'idle',   -- idle|classify|route|execute|validate|respond|recover|emergency
    state_data   TEXT NOT NULL DEFAULT '{}',      -- JSON
    mode         TEXT NOT NULL DEFAULT 'normal',  -- normal|degraded|emergency
    updated_at   INTEGER NOT NULL DEFAULT 0
);

-- Minor index for memory TTL cleanup.
CREATE INDEX IF NOT EXISTS idx_mem_expires ON memories(expires_at);