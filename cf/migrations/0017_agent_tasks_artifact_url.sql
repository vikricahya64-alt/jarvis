-- 0017_agent_tasks_artifact_url.sql
-- Executor artifacts are committed to the (public) repo so the owner can open
-- the real deliverable — not just the truncated text copy in the DM.
ALTER TABLE agent_tasks ADD COLUMN artifact_url TEXT;