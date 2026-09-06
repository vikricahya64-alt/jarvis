-- =====================================================================
-- Migration 0010: Monitoring & deployment safety infrastructure
-- Tables for: error_monitor, deploy_safety, recovery_loop, config_optimizer
-- =====================================================================

-- Error tracking for SRE-style monitoring (error_monitor.ts)
CREATE TABLE IF NOT EXISTS system_errors (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  severity TEXT NOT NULL,       -- 'low' | 'medium' | 'high' | 'critical'
  category TEXT NOT NULL,       -- 'llm_failure' | 'd1_error' | 'kv_error' | etc.
  message TEXT NOT NULL,
  stack_trace TEXT NOT NULL DEFAULT '',
  diagnosis TEXT,               -- Groq-powered root cause analysis
  status TEXT NOT NULL,         -- 'PENDING_FIX' | 'DIAGNOSED' | 'FIX_DEPLOYED' | 'PENDING_REVIEW' | 'IGNORED'
  context TEXT NOT NULL DEFAULT '{}',
  fix_attempted TEXT,
  fix_result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_se_time ON system_errors(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_se_status ON system_errors(status);
CREATE INDEX IF NOT EXISTS idx_se_severity ON system_errors(severity, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_se_category ON system_errors(category);

-- Deployment version tracking (deploy_safety.ts)
CREATE TABLE IF NOT EXISTS deploy_versions (
  version TEXT PRIMARY KEY,
  deployed_at INTEGER NOT NULL,
  deployed_by TEXT NOT NULL DEFAULT 'manual',
  error_rate REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'rolled_back' | 'healthy' | 'broken'
  notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_dv_status ON deploy_versions(status);
CREATE INDEX IF NOT EXISTS idx_dv_deployed ON deploy_versions(deployed_at DESC);

-- Recovery actions audit trail (deploy_safety.ts, jarvis_recovery.ts)
CREATE TABLE IF NOT EXISTS recovery_actions (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,           -- 'auto_revert' | 'manual_revert' | 'config_reset' | 'dependency_update'
  from_version TEXT NOT NULL DEFAULT '',
  to_version TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  success INTEGER NOT NULL DEFAULT 0  -- 0=false, 1=true
);
CREATE INDEX IF NOT EXISTS idx_ra_time ON recovery_actions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ra_type ON recovery_actions(type);

-- Request log for latency/error rate tracking (deploy_safety.ts, config_optimizer.ts)
CREATE TABLE IF NOT EXISTS request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'GET',
  status_code INTEGER NOT NULL DEFAULT 200,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error INTEGER NOT NULL DEFAULT 0  -- 0=ok, 1=error
);
CREATE INDEX IF NOT EXISTS idx_rl_time ON request_log(ts DESC);
