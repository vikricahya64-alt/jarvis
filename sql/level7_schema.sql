-- ============================================================
-- J.A.R.V.I.S. LEVEL 7: SOVEREIGN SELF-EVOLVING SYSTEM SCHEMA
-- Self-repair, model evolution, genetic archive, replication,
-- meta-cognition, and device-health telemetry.
--
-- Run this in the Supabase SQL Editor. Idempotent (safe to re-run).
--
-- Design notes:
--   * self_repair_log   — append-only audit of autonomous bug patches; a
--     patch is never a raw code blob, it stores the generated diff + a
--     SHA-256 commit hash + optional GitHub PR URL. Security/crypto/PII
--     modules are BLOCKED at the application layer, not here.
--   * model_adapters    — registry of QLoRA adapters produced on Colab/Kaggle
--     (T4 GPU); each row points at the authoritative artifact in Supabase
--     Storage (the SHA-256 + .safetensors), plus target node ('oracle' private
--     edge or 'phone' terminal) and rollback pointer to the prior adapter.
--   * replica_registry  — sovereign replication bookkeeping; each replica gets
--     a unique PGP identity fingerprint, a label, and a Tailscale/TCP peer
--     address. Never stores the private key (that stays on the replica).
--   * genetic_archive   — permanent DNA-style snapshots uploaded to Pinata
--     IPFS; stores the returned CID + SHA-256 of the packaged archive. Used by
--     /dna for disaster-recovery restore.
--   * meta_audit_log    — immutable weekly self-analysis: performance metrics,
--     Groq recommendation, risk classification (low => auto-fix, high =>
--     human review), and whether it was applied or parked for review.
--   * device_health_metrics — time-series of the sovereign terminal's telemetry
--     (temp_C, ram_percent, routing_mode, latency_ms) so the router + /device
--     can show trends and calibrate thermal guardrails for the Helio G85.
--
-- All RLS respects get_telegram_id() like every other table in this project and
-- grants full access to service_role (the backend, server-side key).
-- ============================================================

-- ------------------------------------------------------------------
-- 1. SELF-REPAIR LOG (autonomous bug-fix audit trail)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.self_repair_log (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL DEFAULT 0,
    module        text        NOT NULL,                 -- e.g. 'api/webhook.py'
    issue         text        NOT NULL,                 -- Groq diagnosis summary
    severity      text        NOT NULL DEFAULT 'low',   -- low|medium|high|critical
    diff          text        NOT NULL DEFAULT '',      -- generated patch (diff)
    commit_hash   text        NOT NULL DEFAULT '',      -- sha256 of the applied state
    pr_url        text        NOT NULL DEFAULT '',      -- GitHub PR once created
    status        text        NOT NULL DEFAULT 'proposed', -- proposed|tested|applied|failed|rejected|escalated
    attempts      integer     NOT NULL DEFAULT 0,       -- patch attempts (>=2 => escalate)
    blocked       boolean     NOT NULL DEFAULT false,   -- true if security/crypto/PII
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS self_repair_status_idx ON self_repair_log (status, created_at DESC);
CREATE INDEX IF NOT EXISTS self_repair_module_idx  ON self_repair_log (module);

-- ------------------------------------------------------------------
-- 2. MODEL ADAPTERS (QLoRA fine-tuned adapters from Colab/Kaggle)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.model_adapters (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL DEFAULT 0,
    name          text        NOT NULL,                 -- adapter label e.g. qwen-1.5b-jarvis-v2
    base_model    text        NOT NULL DEFAULT 'Qwen/Qwen2.5-1.5B-Instruct',
    target        text        NOT NULL DEFAULT 'phone', -- 'oracle' | 'phone'
    artifact_url  text        NOT NULL DEFAULT '',      -- Supabase Storage / Colab drive URL
    sha256        text        NOT NULL DEFAULT '',      -- integrity checksum of the adapter
    params_qlora  numeric,                              -- # of trainable params (optional)
    loss_valid     numeric,                             -- holdout validation loss
    status        text        NOT NULL DEFAULT 'training', -- training|validated|deployed|rolled_back|failed
    prev_adapter   uuid,                                -- rollback pointer (previous)
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS model_adapters_status_idx ON model_adapters (status, created_at DESC);

-- ------------------------------------------------------------------
-- 3. REPLICA REGISTRY (sovereign replication)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.replica_registry (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL DEFAULT 0,
    label         text        NOT NULL,                 -- friendly name of the replica
    peer_addr     text        NOT NULL DEFAULT '',      -- tailscale ip:port / ssh target
    pgp_fingerprint text      NOT NULL DEFAULT '',      -- unique identity per replica
    components    text[]      NOT NULL DEFAULT '{}',    -- bundled component names
    status        text        NOT NULL DEFAULT 'pending', -- pending|active|offline|retired
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS replica_registry_status_idx ON replica_registry (status);

-- ------------------------------------------------------------------
-- 4. GENETIC ARCHIVE (permanent DNA on IPFS)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.genetic_archive (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL DEFAULT 0,
    version       text        NOT NULL,                 -- semver / dna-vN
    cid           text        NOT NULL,                 -- Pinata IPFS CID
    sha256        text        NOT NULL DEFAULT '',      -- integrity of packaged archive
    manifest      jsonb       NOT NULL DEFAULT '{}'::jsonb, -- contents: code hash, model weights hash, prefs
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS genetic_archive_ver_idx ON genetic_archive (version DESC);

-- ------------------------------------------------------------------
-- 5. META AUDIT LOG (immutable weekly self-analysis)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meta_audit_log (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL DEFAULT 0,
    week          text        NOT NULL,                 -- e.g. 2026-W34
    metrics       jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- perf snapshot
    recommendation jsonb      NOT NULL DEFAULT '{}'::jsonb,  -- Groq proposal
    risk          text        NOT NULL DEFAULT 'low',   -- low|high
    status        text        NOT NULL DEFAULT 'proposed', -- proposed|applied|review|paused
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meta_audit_week_idx ON meta_audit_log (telegram_id, week DESC);

-- ------------------------------------------------------------------
-- 6. DEVICE HEALTH METRICS (realme C25s telemetry time-series)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.device_health_metrics (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL DEFAULT 0,
    temp_c        numeric,
    ram_percent   numeric,
    routing_mode  text        NOT NULL DEFAULT 'auto',  -- auto|local|cloud|oracle
    latency_ms    integer     NOT NULL DEFAULT 0,
    source        text        NOT NULL DEFAULT 'device',-- device|probe
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_health_metrics_ts_idx
  ON device_health_metrics (telegram_id, created_at DESC);

-- ------------------------------------------------------------------
-- 7. RLS — enable + policies (respect get_telegram_id())
-- ------------------------------------------------------------------
ALTER TABLE public.self_repair_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_adapters       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.replica_registry     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genetic_archive      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_audit_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_health_metrics ENABLE ROW LEVEL SECURITY;

-- Self-repair log: users can read their own (it is a transparency journal);
-- only service_role writes patches.
DROP POLICY IF EXISTS "Users select own self repair log" ON public.self_repair_log;
CREATE POLICY "Users select own self repair log"
  ON public.self_repair_log FOR SELECT
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);

DROP POLICY IF EXISTS "Service writes self repair log" ON public.self_repair_log;
CREATE POLICY "Service writes self repair log"
  ON public.self_repair_log FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);

-- Model adapters: owner select + service writes.
DROP POLICY IF EXISTS "Users select own adapters" ON public.model_adapters;
CREATE POLICY "Users select own adapters"
  ON public.model_adapters FOR SELECT
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);
DROP POLICY IF EXISTS "Service writes adapters" ON public.model_adapters;
CREATE POLICY "Service writes adapters"
  ON public.model_adapters FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);

-- Replica registry: owner select + service writes.
DROP POLICY IF EXISTS "Users select own replicas" ON public.replica_registry;
CREATE POLICY "Users select own replicas"
  ON public.replica_registry FOR SELECT
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);
DROP POLICY IF EXISTS "Service writes replicas" ON public.replica_registry;
CREATE POLICY "Service writes replicas"
  ON public.replica_registry FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);

-- Genetic archive: owner select + service writes.
DROP POLICY IF EXISTS "Users select own archive" ON public.genetic_archive;
CREATE POLICY "Users select own archive"
  ON public.genetic_archive FOR SELECT
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);
DROP POLICY IF EXISTS "Service writes archive" ON public.genetic_archive;
CREATE POLICY "Service writes archive"
  ON public.genetic_archive FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);

-- Meta audit log: owner select + service writes.
DROP POLICY IF EXISTS "Users select own meta audit" ON public.meta_audit_log;
CREATE POLICY "Users select own meta audit"
  ON public.meta_audit_log FOR SELECT
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);
DROP POLICY IF EXISTS "Service writes meta audit" ON public.meta_audit_log;
CREATE POLICY "Service writes meta audit"
  ON public.meta_audit_log FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);

-- Device health metrics: owner select + service writes.
DROP POLICY IF EXISTS "Users select own device metrics" ON public.device_health_metrics;
CREATE POLICY "Users select own device metrics"
  ON public.device_health_metrics FOR SELECT
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);
DROP POLICY IF EXISTS "Service writes device metrics" ON public.device_health_metrics;
CREATE POLICY "Service writes device metrics"
  ON public.device_health_metrics FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);

-- ------------------------------------------------------------------
-- Service role: full access for the backend (server-side key).
-- ------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.self_repair_log      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.model_adapters       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.replica_registry     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.genetic_archive      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meta_audit_log       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_health_metrics TO service_role;

-- ============================================================
-- DONE. Next: see docs/level7-setup.md for deployment + hardware
-- safety calibration guide.
-- ============================================================
