-- =====================================================================
-- J.A.R.V.I.S. Level 12 — D1 schema migration (0004_maestro.sql)
-- Autonomous Sovereign Maestro + Graceful Degradation tables.
--   plans            : multi-step plan orchestration (decomposed goals)
--   plan_steps       : individual consented steps of a plan
--   scheduled_tasks  : recurring autonomous tasks (owner-delegated)
--   daily_agenda     : owner-approved daily briefing items
--   degradation_state : quota snapshot + disabled (non-essential) features
--   degradation_alerts: degradation event log for the owner
--
-- Free tier: D1 5GB, 100k reads/day — all tables are small + bounded rows.
-- R2/IPFS intentionally NOT used (requires payment card).
--
-- Sovereignty: autonomous execution NEVER runs on its own for novel/risky
-- items; it only fires for owner-delegated (approved=1) rows and is audited
-- in obedience_audit (origin=autonomous). A global autonomy-pause (/pause)
-- in dms_state.config_json halts all of it. See cf/src/lib/maestro.ts.
-- =====================================================================

-- Multi-step plan produced by Groq decomposition; master advances one step
-- at a time, always under covenant validation + consent for novel risks.
CREATE TABLE IF NOT EXISTS plans (
    id          TEXT PRIMARY KEY,          -- sha256(owner:goal:ts)
    owner_id    INTEGER NOT NULL,
    goal        TEXT    NOT NULL DEFAULT '',
    description TEXT    NOT NULL DEFAULT '',
    cadence     TEXT    NOT NULL DEFAULT 'once', -- hourly|daily|weekly|once
    schedule_at INTEGER NOT NULL DEFAULT 0,       -- unix ms next run
    last_run    INTEGER NOT NULL DEFAULT 0,
    status      TEXT    NOT NULL DEFAULT 'active',-- active|paused|completed
    created_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_plans_owner ON plans(owner_id, created_at);

-- Individual steps of a plan. status: pending|approved|rejected|completed|skipped|blocked
CREATE TABLE IF NOT EXISTS plan_steps (
    id          TEXT PRIMARY KEY,          -- sha256(planId:index)
    owner_id    INTEGER NOT NULL,
    plan_id     TEXT    NOT NULL,
    step_index  INTEGER NOT NULL DEFAULT 0,
    goal        TEXT    NOT NULL DEFAULT '',
    description TEXT    NOT NULL DEFAULT '',  -- concrete action for the step
    outcome     TEXT    NOT NULL DEFAULT '',  -- expected result
    priority    INTEGER NOT NULL DEFAULT 5,   -- 1-10, higher = riskier
    status      TEXT    NOT NULL DEFAULT 'pending',
    executed_at INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ps_plan ON plan_steps(plan_id, status);
CREATE INDEX IF NOT EXISTS idx_ps_owner ON plan_steps(owner_id);

-- Recurring autonomous tasks, pre-approved by the owner.
-- Fires only when schedule_at <= now AND approved=1 AND NOT autonomy-paused.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id          TEXT PRIMARY KEY,          -- sha256(owner:desc:nextRun)
    owner_id    INTEGER NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    cadence     TEXT    NOT NULL DEFAULT 'once', -- hourly|daily|weekly|once
    schedule_at INTEGER NOT NULL DEFAULT 0,       -- unix ms next run
    approved    INTEGER NOT NULL DEFAULT 1,       -- 1 = owner delegated
    risk_level  TEXT    NOT NULL DEFAULT 'low',    -- low|medium|high
    last_run    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_st_owner_due ON scheduled_tasks(owner_id, schedule_at);

-- Owner-approved daily agenda items (Morning Briefing source at cron 06:00).
-- Autonomous execution only for proven-delegated (approved=1) items.
CREATE TABLE IF NOT EXISTS daily_agenda (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id    INTEGER NOT NULL,
    day         TEXT    NOT NULL DEFAULT '*',  -- ISO day or '*' (every day)
    time_utc    TEXT    NOT NULL DEFAULT '06:00',
    description TEXT    NOT NULL DEFAULT '',
    approved    INTEGER NOT NULL DEFAULT 0,   -- 1 = owner delegated
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_da_owner ON daily_agenda(owner_id, active);

-- Quota snapshot for Graceful Degradation (updated by cron).
-- Essential features (covenant/DMS/override) are never disabled; only
-- non-essential functionality degrades. Columns match cf/src/lib/degradation.ts.
CREATE TABLE IF NOT EXISTS degradation_state (
    owner_id          INTEGER PRIMARY KEY,
    quota_snapshot    REAL    NOT NULL DEFAULT 100,  -- usage % (0-100)
    remaining_pct     REAL    NOT NULL DEFAULT 100,  -- remaining %
    disabled_features TEXT    NOT NULL DEFAULT '[]', -- JSON array of feature names
    updated_at        INTEGER NOT NULL DEFAULT 0
);

-- Degradation alerts logged for the owner (Telegram integration).
CREATE TABLE IF NOT EXISTS degradation_alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL,
    message    TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_da_alert_owner ON degradation_alerts(owner_id, created_at);