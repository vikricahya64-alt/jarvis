-- ============================================================
-- J.A.R.V.I.S. LEVEL 6: HYBRID EDGE-CLOUD ORCHESTRATOR SCHEMA
-- Routing + data-residency audit for the sovereign local core.
--
-- Run this in the Supabase SQL Editor. Idempotent (safe to re-run).
-- Notes:
--   * routing_log records every local/cloud routing decision (timestamp,
--     message_hash, decision, latency, device_status) so the router can
--     self-optimize and be audited.
--   * data_residency_audit tracks what stayed local vs went cloud, which
--     PII was detected, and what was redacted — the backbone of
--     privacy compliance.
--   * RLS respects get_telegram_id() like every other table in this project.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. ROUTING LOG: every hybrid routing decision (immutable, append-only)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.routing_log (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL,
    message_hash  text        NOT NULL,           -- sha256 of normalized text
    decision      text        NOT NULL,           -- 'local' | 'cloud' | 'fallback' | 'force_local' | 'force_cloud'
    complexity    numeric     NOT NULL DEFAULT 0,
    sensitivity   numeric     NOT NULL DEFAULT 0, -- 0..1 PII/sensitivity score
    latency_ms    integer     NOT NULL DEFAULT 0, -- routed execution latency
    device_status jsonb       NOT NULL DEFAULT '{}'::jsonb, -- temp/ram/threads snapshot
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS routing_log_owner_idx ON routing_log (telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS routing_log_hash_idx  ON routing_log (message_hash);

-- ------------------------------------------------------------------
-- 2. DATA RESIDENCY AUDIT: what stayed local vs went to cloud
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.data_residency_audit (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id    bigint      NOT NULL,
    record_id      text        NOT NULL,           -- task/insight/backup id
    location       text        NOT NULL,           -- 'local' | 'cloud' | 'backup'
    pii_detected   boolean     NOT NULL DEFAULT false,
    pii_types      text[]      NOT NULL DEFAULT '{}',
    redacted_fields text[]     NOT NULL DEFAULT '{}',
    execution_note text        NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS resid_owner_idx ON data_residency_audit (telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS resid_location_idx ON data_residency_audit (location);

-- ------------------------------------------------------------------
-- 3. DEVICE STATUS: Realme C25s heartbeat (written by the device poller,
--    read by the hybrid router to decide local vs cloud).
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.device_status (
    telegram_id bigint      PRIMARY KEY,
    online      boolean     NOT NULL DEFAULT false,
    temp_c      numeric,
    ram_pct     numeric,
    threads     integer,
    latency_ms  integer,
    model       text        NOT NULL DEFAULT '',
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------
-- 4. DEVICE QUEUE: encrypted tasks awaiting the local device.
--    The cloud encrypts+queues here; the Termux poller drains it.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.device_queue (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL,
    envelope      jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- AES-GCM payload
    status        text        NOT NULL DEFAULT 'PENDING',    -- PENDING|SENT|DONE|FAILED
    task_id_fk    uuid        REFERENCES tasks(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_queue_pending_idx ON device_queue (telegram_id, status, created_at);

-- ------------------------------------------------------------------
-- 5. RLS
-- ------------------------------------------------------------------
ALTER TABLE public.routing_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_residency_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can select own routing log" ON public.routing_log;
CREATE POLICY "Users can select own routing log"
  ON public.routing_log FOR SELECT
  USING (telegram_id = get_telegram_id());

DROP POLICY IF EXISTS "Service inserts routing log" ON public.routing_log;
CREATE POLICY "Service inserts routing log"
  ON public.routing_log FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id());

DROP POLICY IF EXISTS "Users can select own residency audit" ON public.data_residency_audit;
CREATE POLICY "Users can select own residency audit"
  ON public.data_residency_audit FOR SELECT
  USING (telegram_id = get_telegram_id());

DROP POLICY IF EXISTS "Users can insert own residency audit" ON public.data_residency_audit;
CREATE POLICY "Users can insert own residency audit"
  ON public.data_residency_audit FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id());

-- ----------------------------------------------------------------
-- Service role performs background reads/writes.
-- ----------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.routing_log TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.data_residency_audit TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_status TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_queue TO service_role;

-- Grant the sequence privileges for any SERIAL usage (defensive; the tables
-- use uuid defaults so this is a no-op guard against older migrations).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ============================================================
-- DONE. Next: see docs/level6-setup.md for deployment steps.
-- ============================================================
