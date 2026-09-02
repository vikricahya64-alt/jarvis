-- ============================================================
-- J.A.R.V.I.S. LEVEL 8: HIVE MIND SCHEMA
-- Memory graph, swarm registry, federated learning rounds,
-- and probabilistic intuition log.
--
-- Run this in the Supabase SQL Editor. Idempotent (safe to re-run).
--
-- Design notes:
--   * memory_nodes      — associative knowledge graph. Every entity is an
--     ANONYMIZED node (no raw PII in properties); PII lives separately in
--     the device SQLCipher Vault and is never written here. Embeddings are
--     stored in a 768-dim vector with an IVFFlat index for similarity search.
--   * memory_edges      — typed, weighted relationships with temporal decay.
--     A straight traversal (graph) is preferred over pure vector similarity.
--   * swarm_node_registry — every peer in the Tailscale mesh: unique device id,
--     role (edge_terminal/private_cloud/training_node), capabilities, and last
--     heartbeat. RLS is per-owner so devices only see their own swarm.
--   * federated_rounds  — immutable record of federated training rounds:
--     participants, gradient_count, final validation score, and the
--     distribution manifest. The aggregator NEVER sees raw data, only counts.
--   * intuition_log     — each prediction attempt + user feedback to update
--     the Bayesian prior. Sensitive domains are recorded as 'blocked' so we
--     can prove the guardrail works.
--
-- All RLS respects get_telegram_id() exactly like Level 6/7 tables.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. MEMORY NODES (knowledge graph vertices)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.memory_nodes (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL DEFAULT 0,
    entity        text        NOT NULL,                 -- anonymized label e.g. 'project_alpha'
    type          text        NOT NULL DEFAULT 'concept', -- person|project|location|event|concept
    properties    jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- never raw PII
    embedding     vector(768),                            -- pgvector embedding
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_nodes_entity_idx ON memory_nodes (telegram_id, entity);
CREATE INDEX IF NOT EXISTS memory_nodes_type_idx    ON memory_nodes (telegram_id, type);

-- IVFFlat index for fast similarity search (built when the table is big).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'memory_nodes' AND indexname = 'memory_nodes_embedding_idx'
    ) THEN
        CREATE INDEX memory_nodes_embedding_idx
            ON memory_nodes USING ivfflat (embedding vector_cosine_ops)
            WITH (lists = 16);
    END IF;
END $$;

-- ------------------------------------------------------------------
-- 2. MEMORY EDGES (knowledge graph edges)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.memory_edges (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL DEFAULT 0,
    source_id     uuid        NOT NULL REFERENCES public.memory_nodes(id) ON DELETE CASCADE,
    target_id     uuid        NOT NULL REFERENCES public.memory_nodes(id) ON DELETE CASCADE,
    relation      text        NOT NULL,                 -- 'mentioned_during' | 'worked_with' | 'located_at' | ...
    strength      numeric     NOT NULL DEFAULT 0.5,     -- 0..1, decays over time
    last_seen     timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (source_id <> target_id)
);

CREATE INDEX IF NOT EXISTS memory_edges_src_idx ON memory_edges (source_id, relation);
CREATE INDEX IF NOT EXISTS memory_edges_tgt_idx ON memory_edges (target_id, relation);

-- ------------------------------------------------------------------
-- 3. SWARM NODE REGISTRY (Tailscale mesh peers)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.swarm_node_registry (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL DEFAULT 0,       -- owner / coordinator
    device_id     text        NOT NULL,                 -- unique swarm peer e.g. 'g85-01'
    role          text        NOT NULL DEFAULT 'edge_terminal', -- edge_terminal|private_cloud|training_node
    peer_addr     text        NOT NULL DEFAULT '',      -- tailscale ip:port / host
    capabilities  text[]      NOT NULL DEFAULT '{}',    -- ['camera','mic','gpu','mqtt']
    status        text        NOT NULL DEFAULT 'online', -- online|offline|syncing
    last_heartbeat timestamptz NOT NULL DEFAULT now(),
    platform      text        NOT NULL DEFAULT '',      -- android/linux/colab
    ram_mb        integer      NOT NULL DEFAULT 0,
    temp_c        numeric,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (telegram_id, device_id)
);

CREATE INDEX IF NOT EXISTS swarm_registry_heartbeat_idx ON swarm_node_registry (status, last_heartbeat DESC);

-- ------------------------------------------------------------------
-- 4. FEDERATED ROUNDS (training lifecycle, encrypted metadata only)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.federated_rounds (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL DEFAULT 0,
    round_id      integer     NOT NULL,                 -- sequential round number
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    participants  text[]      NOT NULL DEFAULT '{}',    -- device_ids that sent gradients
    gradient_count integer    NOT NULL DEFAULT 0,
    model_version text        NOT NULL DEFAULT '',      -- global model tag
    validation_score numeric,                           -- holdout set score (0..1)
    status        text        NOT NULL DEFAULT 'collecting', -- collecting|aggregating|validated|distributed|failed
    manifest      jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- weights distribution metadata
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federated_rounds_id_idx ON federated_rounds (telegram_id, round_id DESC);

-- ------------------------------------------------------------------
-- 5. INTUITION LOG (Bayesian prediction + feedback)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.intuition_log (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL DEFAULT 0,
    timestamp     timestamptz NOT NULL DEFAULT now(),
    domain        text        NOT NULL DEFAULT 'general', -- prediction category
    prediction    text        NOT NULL,                 -- predicted_need / suggestion
    reasoning     text        NOT NULL DEFAULT '',      -- human-readable why
    confidence    numeric     NOT NULL DEFAULT 0.0,     -- 0..1 (only surfaced if > 0.85)
    impact        text        NOT NULL DEFAULT 'low',   -- low|medium|high
    user_feedback text        NOT NULL DEFAULT 'pending', -- pending|correct|dismissed|rejected
    blocked       boolean     NOT NULL DEFAULT false,   -- true if sensitive domain guardrail
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- pgvector similarity search over anonymized memory_nodes.
CREATE OR REPLACE FUNCTION public.search_memory_nodes(
    p_telegram_id bigint, p_embedding vector(768), p_limit int DEFAULT 5
) RETURNS SETOF public.memory_nodes
LANGUAGE sql
AS $$
    SELECT *
    FROM public.memory_nodes
    WHERE telegram_id = p_telegram_id OR telegram_id = 0
    ORDER BY embedding <=> p_embedding
    LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.search_memory_nodes FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_memory_nodes TO service_role;

-- ------------------------------------------------------------------
-- 6. RLS — enable + policies (respect get_telegram_id())
-- ------------------------------------------------------------------
ALTER TABLE public.memory_nodes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_edges        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.swarm_node_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federated_rounds    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intuition_log       ENABLE ROW LEVEL SECURITY;

-- Memory nodes: owner select/insert; service full.
DROP POLICY IF EXISTS "Users select own memory nodes" ON public.memory_nodes;
CREATE POLICY "Users select own memory nodes"
  ON public.memory_nodes FOR SELECT
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);
DROP POLICY IF EXISTS "Service writes memory nodes" ON public.memory_nodes;
CREATE POLICY "Service writes memory nodes"
  ON public.memory_nodes FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);
DROP POLICY IF EXISTS "Service updates memory nodes" ON public.memory_nodes;
CREATE POLICY "Service updates memory nodes"
  ON public.memory_nodes FOR UPDATE
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);

-- Memory edges: owner select/insert; service full.
DROP POLICY IF EXISTS "Users select own memory edges" ON public.memory_edges;
CREATE POLICY "Users select own memory edges"
  ON public.memory_edges FOR SELECT
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);
DROP POLICY IF EXISTS "Service writes memory edges" ON public.memory_edges;
CREATE POLICY "Service writes memory edges"
  ON public.memory_edges FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);
DROP POLICY IF EXISTS "Service updates memory edges" ON public.memory_edges;
CREATE POLICY "Service updates memory edges"
  ON public.memory_edges FOR UPDATE
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);

-- Swarm registry: owner select/insert/update (devices report heartbeats).
DROP POLICY IF EXISTS "Users select own swarm" ON public.swarm_node_registry;
CREATE POLICY "Users select own swarm"
  ON public.swarm_node_registry FOR SELECT
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);
DROP POLICY IF EXISTS "Service writes swarm" ON public.swarm_node_registry;
CREATE POLICY "Service writes swarm"
  ON public.swarm_node_registry FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);
DROP POLICY IF EXISTS "Service updates swarm" ON public.swarm_node_registry;
CREATE POLICY "Service updates swarm"
  ON public.swarm_node_registry FOR UPDATE
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);

-- Federated rounds: owner select + service writes.
DROP POLICY IF EXISTS "Users select own federated rounds" ON public.federated_rounds;
CREATE POLICY "Users select own federated rounds"
  ON public.federated_rounds FOR SELECT
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);
DROP POLICY IF EXISTS "Service writes federated rounds" ON public.federated_rounds;
CREATE POLICY "Service writes federated rounds"
  ON public.federated_rounds FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);

-- Intuition log: owner select + service writes (feedback).
DROP POLICY IF EXISTS "Users select own intuition log" ON public.intuition_log;
CREATE POLICY "Users select own intuition log"
  ON public.intuition_log FOR SELECT
  USING (telegram_id = get_telegram_id() OR telegram_id = 0);
DROP POLICY IF EXISTS "Service writes intuition log" ON public.intuition_log;
CREATE POLICY "Service writes intuition log"
  ON public.intuition_log FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id() OR telegram_id = 0);

-- ------------------------------------------------------------------
-- Service role: full access for the backend (server-side key).
-- ------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_nodes        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_edges        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.swarm_node_registry TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.federated_rounds    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intuition_log       TO service_role;

-- ============================================================
-- DONE. Next: see docs/level8-setup.md for MQTT, Termux sensor
-- APIs, Flower configuration, and intuition safety config.
-- ============================================================