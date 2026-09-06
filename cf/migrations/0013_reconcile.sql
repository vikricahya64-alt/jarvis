-- 0013_reconcile.sql
-- Fix request_log schema conflict between 0006 and 0010.
-- 0006 created request_log with (provider, status, step, note).
-- 0010 tried to create it with (path, method, status_code, error) but was
-- silently ignored by CREATE TABLE IF NOT EXISTS.
-- This migration adds the 0010 columns to the existing table.

ALTER TABLE request_log ADD COLUMN path TEXT NOT NULL DEFAULT '';
ALTER TABLE request_log ADD COLUMN method TEXT NOT NULL DEFAULT 'GET';
ALTER TABLE request_log ADD COLUMN status_code INTEGER NOT NULL DEFAULT 200;
ALTER TABLE request_log ADD COLUMN error INTEGER NOT NULL DEFAULT 0;

-- Add index for the monitoring queries (deploy_safety, config_optimizer)
CREATE INDEX IF NOT EXISTS idx_rl_path ON request_log(path);
CREATE INDEX IF NOT EXISTS idx_rl_error ON request_log(error, ts DESC);
