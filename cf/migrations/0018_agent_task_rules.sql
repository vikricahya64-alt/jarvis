-- 0018_agent_task_rules.sql
-- Recurring heavy tasks (B3): one rule row = a repeating delegable task that
-- fires on its own cadence (daily / weekly, WIB) creating agent_tasks
-- instances. Rows survive by design (they are templates, not instances).
CREATE TABLE IF NOT EXISTS agent_task_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  task TEXT NOT NULL,
  recur_spec TEXT NOT NULL,
  next_fire_at INTEGER NOT NULL,
  last_fire_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_task_rules_due ON agent_task_rules(active, next_fire_at);

-- Instances record which recurring rule produced them (nullable = one-shot).
ALTER TABLE agent_tasks ADD COLUMN rule_id INTEGER;