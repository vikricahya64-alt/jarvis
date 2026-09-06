-- =====================================================================
-- J.A.R.V.I.S. L25 — D1 schema migration (0016_agent_tasks.sql)
-- Serverless delegation ledger: heavy digital-work tasks queued for a
-- free cloud executor (GitHub Actions, ephemeral VM) so JARVIS "borrows"
-- opencode orchestration + real-world execution without local infra.
--
-- Lifecycle: pending -> running (dispatched) -> done | failed | rejected.
--   pending   = accepted, awaiting dispatch
--   running   = dispatched to GitHub; run_id records the workflow run
--   done      = result received via /agent/done callback
--   failed    = executor reported failure (reason in error)
-- =====================================================================

CREATE TABLE IF NOT EXISTS agent_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  task TEXT NOT NULL,
  executor TEXT NOT NULL DEFAULT 'github',
  status TEXT NOT NULL DEFAULT 'pending',
  run_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  result TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_owner ON agent_tasks(owner_id, status);