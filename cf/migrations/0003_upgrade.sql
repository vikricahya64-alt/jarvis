-- =====================================================================
-- J.A.R.V.I.S. Level 11 — D1 schema migration (0003_upgrade.sql)
-- Adds task_counters (queue depth) and conversation_log (turn memory).
-- Free tier: D1 5GB, 100k reads/day — both tables are small and bounded.
-- =====================================================================

-- Lightweight producer/consumer counters so /queue_status isn't always zeros.
CREATE TABLE IF NOT EXISTS task_counters (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    queue     TEXT    NOT NULL DEFAULT 'standard', -- high|standard|low
    owner_id  INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tc_queue ON task_counters(queue);

-- Conversation turn memory (last N turns for context-aware replies).
-- Bounded: capped inserts keep rows small; oldest pruned automatically.
CREATE TABLE IF NOT EXISTS conversation_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id  INTEGER NOT NULL,
    ts        INTEGER NOT NULL DEFAULT 0,
    role      TEXT    NOT NULL DEFAULT 'user', -- user|assistant
    content   TEXT    NOT NULL DEFAULT '',
    search_used TEXT NOT NULL DEFAULT '' -- topic/search hint if a web search ran
);
CREATE INDEX IF NOT EXISTS idx_cl_owner_time ON conversation_log(owner_id, ts DESC);
