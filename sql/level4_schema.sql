-- ============================================================
-- J.A.R.V.I.S. LEVEL 4: COGNITIVE ORCHESTRATOR SCHEMA
-- Swarm agents, deep-reasoning queue, hybrid memory retrieval.
--
-- Run this in the Supabase SQL Editor. Idempotent (safe to re-run).
-- Notes:
--   * tasks get swarm fields: parent_task_id, agent_type, retry_count.
--   * chat_history gets metadata JSONB (GIN) + a generated tsvector
--     column (free BM25-style full-text boost on top of pg_trgm).
--   * matching is exposed as match_chat_history_hybrid(...); vector
--     similarity is OPTIONAL (pass p_vector) — we stay free-tier
--     without an embedding API, so pg_trgm + ts_rank carry the load.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. TASKS: swarm columns (parent/child + agent routing + retries)
-- ------------------------------------------------------------------
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agent_type TEXT
    CHECK (agent_type IS NULL OR agent_type IN
           ('researcher', 'coder', 'reviewer', 'writer')),
  ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS tasks_agent_idx ON tasks (agent_type, status);

-- ------------------------------------------------------------------
-- 2. CHAT_HISTORY: metadata + full-text searchable corpus
-- ------------------------------------------------------------------
ALTER TABLE chat_history
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_chat_meta ON chat_history USING GIN (metadata);
CREATE INDEX IF NOT EXISTS chat_history_tsv_idx ON chat_history USING GIN (content_tsv);

-- ------------------------------------------------------------------
-- 3. DOCUMENTS: per-document metadata is helpful for the memory bridge
-- ------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ------------------------------------------------------------------
-- 4. HYBRID RETRIEVAL: pg_trgm word-similarity + ts_rank FTS + optional
--    vector cosine. Metadata is an optional JSONB containment filter.
--    sses the 'simple' dictionary so both ID and EN text tokenize well.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_chat_history_hybrid(
  p_telegram_id bigint,
  p_query text,
  p_metadata jsonb DEFAULT NULL,
  p_limit integer DEFAULT 6,
  p_vector vector(1536) DEFAULT NULL
) RETURNS TABLE (role text, content text, minutes_ago integer, score numeric, metadata jsonb)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  q tsquery := NULLIF(websearch_to_tsquery('simple', coalesce(p_query, '')), '');
BEGIN
  RETURN QUERY
    SELECT ch.role,
           ch.content,
           GREATEST(0, EXTRACT(EPOCH FROM (now() - ch.created_at)) / 60)::integer AS minutes_ago,
           ROUND((
             1.0 * COALESCE(public.word_similarity(p_query, ch.content), 0)
             + 1.0 * CASE WHEN q IS NOT NULL THEN ts_rank(ch.content_tsv, q) ELSE 0 END
             + 1.0 * CASE WHEN p_vector IS NOT NULL AND ch.embedding IS NOT NULL
                          THEN 1 - (ch.embedding <=> p_vector) ELSE 0 END
           )::numeric, 3) AS score,
           ch.metadata
      FROM chat_history ch
     WHERE ch.telegram_id = p_telegram_id
       AND (
             COALESCE(public.word_similarity(p_query, ch.content), 0) > 0.2
             OR (q IS NOT NULL AND ch.content_tsv @@ q)
             OR (p_vector IS NOT NULL AND ch.embedding IS NOT NULL)
           )
       AND ch.metadata @> COALESCE(p_metadata, '{}'::jsonb)
     ORDER BY score DESC, ch.created_at DESC
     LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.match_chat_history_hybrid(
  bigint, text, jsonb, integer, vector) TO service_role;

-- ------------------------------------------------------------------
-- 5. MONITORING VIEW: active (PENDING/PROCESSING) tasks incl. swarm
--    fields and the number of still-running children, for health dashboards.
-- ------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_active_tasks AS
SELECT t.id,
       t.telegram_id,
       t.parent_task_id,
       t.agent_type,
       t.agent,
       t.status,
       t.input,
       t.error,
       t.retry_count,
       t.created_at,
       t.updated_at,
       (SELECT count(*) FROM tasks c
         WHERE c.parent_task_id = t.id
           AND c.status IN ('PENDING', 'PROCESSING')) AS active_children
  FROM tasks t
 WHERE t.status IN ('PENDING', 'PROCESSING');

GRANT SELECT ON public.v_active_tasks TO service_role;

-- ------------------------------------------------------------------
-- 6. RLS for the new surface
--    Service role already bypasses RLS; the policies below cover the
--    authenticated path (the same get_telegram_id() helper as schema.sql).
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can update own tasks" ON tasks;
CREATE POLICY "Users can update own tasks"
  ON tasks FOR UPDATE
  USING (telegram_id = get_telegram_id());

DROP POLICY IF EXISTS "Users can update own chat history" ON chat_history;
CREATE POLICY "Users can update own chat history"
  ON chat_history FOR UPDATE
  USING (telegram_id = get_telegram_id());

-- ============================================================
-- DONE. Next: see docs/level4-setup.md for deployment steps.
-- ============================================================