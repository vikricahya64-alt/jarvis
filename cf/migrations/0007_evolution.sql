--==============================================================================
-- 0007_evolution.sql — Level 13 (Reflective Apprentice): self-improvement layer
--
-- Adopted from public reference research on self-evolving agents on free tier:
--   * reflection_log     -> bounded verbal-reflection loop (Reflexion/Self-Refine)
--   * insights           -> ExpeL-style generalized lessons, evidence-warranted
--   * owner_preferences  -> adaptive preference memory w/ confidence scoring
--   * dream_cycles       -> audit trail of daily consolidation runs (Anthropic
--                           "Dreaming" / Mnemosyne BEAM)
--   * memories columns   -> recency/access tracking for consolidation + pruning
--
-- All 100% free-tier D1. The agent only ever INSERTs into insights/preferences/
-- reflection_log (append-only, evidence-warranted). Schema itself changes ONLY
-- via owner-run migration scripts (never self-modified). Owner may disable any
-- insight/preference without deleting it.
--==============================================================================

-- Recency/access tracking on episodic memory (for consolidation + phantom-rule
-- evidence counting). Backfill-safe: defaults keep existing rows valid.
ALTER TABLE memories ADD COLUMN last_retrieved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;

-- Append-only reflection journal (Pillar 1: bounded 1-round generate->critic).
CREATE TABLE IF NOT EXISTS reflection_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   INTEGER NOT NULL,
    turn_text    TEXT NOT NULL DEFAULT '',
    output       TEXT NOT NULL DEFAULT '',
    errors       TEXT NOT NULL DEFAULT '',   -- tool/status errors observed
    critique     TEXT NOT NULL DEFAULT '',
    refined      TEXT NOT NULL DEFAULT '',
    score        REAL NOT NULL DEFAULT 0,    -- rubric 1..5
    reflected    INTEGER NOT NULL DEFAULT 0  -- 0 = soft defers, 1 = took action
);
CREATE INDEX IF NOT EXISTS idx_reflection_time ON reflection_log(created_at DESC);

-- Generalized lessons from recurring corrections/failures (Pillar 3: ExpeL).
-- INSERT-only by the agent; owner may flip `disabled`; evidence-warrant enforced
-- in code (min_evidence) so we never learn "phantom" rules about this owner.
CREATE TABLE IF NOT EXISTS insights (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_text        TEXT NOT NULL,
    category         TEXT NOT NULL DEFAULT 'behavior',  -- behavior|format|tone|timing|safety
    evidence_ids     TEXT NOT NULL DEFAULT '[]',         -- JSON array of memory ids
    evidence_count   INTEGER NOT NULL DEFAULT 0,
    confidence       REAL NOT NULL DEFAULT 0.5,          -- 0..1
    created_at       INTEGER NOT NULL,
    last_validated_at INTEGER NOT NULL DEFAULT 0,        -- bumped on each use
    disabled         INTEGER NOT NULL DEFAULT 0          -- owner-disable (no delete)
);
CREATE INDEX IF NOT EXISTS idx_insights_disabled ON insights(disabled) WHERE disabled = 0;

-- Adaptive preference memory (Pillar 5: PAHF / evolving conditional memory).
-- Owner sets explicitly (/set-preference) or via dream-cycle consolidation of
-- repeated corrections. Confidence rises on validation, decays if unvalidated.
CREATE TABLE IF NOT EXISTS owner_preferences (
    key              TEXT PRIMARY KEY,
    value            TEXT NOT NULL,
    source           TEXT NOT NULL DEFAULT 'explicit',  -- explicit|inferred
    confidence       REAL NOT NULL DEFAULT 0.5,          -- 0..1
    evidence_count   INTEGER NOT NULL DEFAULT 0,
    last_validated_at INTEGER NOT NULL DEFAULT 0,
    disabled         INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL DEFAULT 0
);

-- Audit trail of daily consolidation ("dream") runs (Pillar 2 / 4).
CREATE TABLE IF NOT EXISTS dream_cycles (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at           INTEGER NOT NULL,
    memories_scanned INTEGER NOT NULL DEFAULT 0,
    insights_extracted INTEGER NOT NULL DEFAULT 0,
    archived         INTEGER NOT NULL DEFAULT 0,
    briefing_sent    INTEGER NOT NULL DEFAULT 0,  -- 0=skip, 1=sent
    errors           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dream_ran ON dream_cycles(ran_at DESC);