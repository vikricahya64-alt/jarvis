-- ============================================================
-- J.A.R.V.I.S. AUTONOMY SCHEMA
-- Proactive scheduler, active learning loop, secure private
-- environment integration (Supabase Vault / pgsodium).
--
-- Run this in the Supabase SQL Editor (Project Settings -> SQL).
-- Safe to re-run (idempotent).
-- ============================================================

-- ------------------------------------------------------------------
-- Extensions
-- ------------------------------------------------------------------
-- pg_trgm powers fuzzy "semantic-ish" preference matching (already used
-- by the knowledge base). pg_cron enables in-database scheduling of the
-- autonomous trigger (alternative to GitHub Actions).
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Requires a Supabase dashboard click-through (Database -> Extensions) or
-- is available on paid tiers; uncomment once enabled if you intend to use
-- pg_cron instead of GitHub Actions:
-- CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Optional: real vector embeddings. Only install if you plan to generate
-- vectors later (e.g. via an embedding API):
-- CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- ============================================================
-- 1. USER PREFERENCES (Active Learning Loop)
--    Learned behaviors/corrections, scoped per user.
-- ============================================================
CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id BIGINT NOT NULL,
  preference TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',     -- style | tone | format | data | general
  source TEXT NOT NULL DEFAULT 'learned',        -- learned | explicit | imported
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  -- Optional vector embedding (pgvector). Left NULL when embeddings are
  -- not generated; matching then falls back to pg_trgm similarity.
  embedding VECTOR(768),
  hit_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_preferences_owner_idx
  ON user_preferences (telegram_chat_id, is_active);
CREATE INDEX IF NOT EXISTS user_preferences_trgm_idx
  ON user_preferences USING gin (preference gin_trgm_ops);

-- ============================================================
-- 2. SCHEDULED JOBS (Autonomous Scheduler)
--    cron-like recurring jobs. next_run_at is the claim field:
--    the trigger CAS-updates it, so concurrent triggers never
--    double-run a job.
-- ============================================================
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,                 -- what the agent should do each run
  interval_minutes INT,                 -- recurring interval (e.g. 1440 = daily)
  cron_expr TEXT,                       -- alternative: 'MM HH * * *' / 'MM HH * * DOW'
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at TIMESTAMPTZ,
  run_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx
  ON scheduled_jobs (enabled, next_run_at);

-- ============================================================
-- 3. PRIVATE CONNECTIONS (Secure integrations)
--    Holds metadata ONLY. Secrets live encrypted in Supabase Vault,
--    referenced by secret_name. Telegram chat id scopes ownership.
-- ============================================================
CREATE TABLE IF NOT EXISTS private_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id BIGINT NOT NULL,
  provider TEXT NOT NULL,               -- gmail | google_drive | notion
  account_name TEXT DEFAULT '',         -- human label (e.g. email / workspace)
  secret_name TEXT NOT NULL,            -- key into Vault (vault.create_secret)
  extra JSONB DEFAULT '{}'::jsonb,      -- refresh_token enc same secret; scopes etc.
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (telegram_chat_id, provider)
);

-- ============================================================
-- 4. PRIVATE USAGE (autonomous rate limiting)
--    Counting-quota guard so runaway triggers cannot hammer the APIs.
-- ============================================================
CREATE TABLE IF NOT EXISTS private_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id BIGINT NOT NULL,
  provider TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  calls INT NOT NULL DEFAULT 1,
  UNIQUE (telegram_chat_id, provider, window_start)
);

-- ============================================================
-- RLS + privileges (idempotent; mirrors todos_schema.sql pattern)
-- ============================================================
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "prefs_rls" ON user_preferences;
CREATE POLICY "prefs_rls" ON user_preferences FOR ALL
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "jobs_rls" ON scheduled_jobs;
CREATE POLICY "jobs_rls" ON scheduled_jobs FOR ALL
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "conn_rls" ON private_connections;
CREATE POLICY "conn_rls" ON private_connections FOR ALL
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "usage_rls" ON private_usage;
CREATE POLICY "usage_rls" ON private_usage FOR ALL
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_jobs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON private_connections TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON private_usage TO service_role;
-- Keep anon/authenticated out of connection & usage internals.
GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences TO authenticated;
GRANT SELECT ON scheduled_jobs TO authenticated;

-- ============================================================
-- 5. VAULT RPCs (pgsodium)
--    SECURITY DEFINER wrappers so the server can read/write encrypted
--    secrets without exposing the vault schema or the pgsodium key.
-- ============================================================
CREATE OR REPLACE FUNCTION public.jv_write_secret(p_name text, p_secret text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = vault, public
AS $$
DECLARE
  v_key_id text;
BEGIN
  -- Upsert semantics: delete any existing secret of the same name first.
  PERFORM vault.delete_secret(s.id)
    FROM vault.decrypted_secrets s WHERE s.name = p_name;
  SELECT vault.create_secret(p_secret, p_name) INTO v_key_id;
  RETURN v_key_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.jv_read_secret(p_name text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = vault, public
AS $$
DECLARE
  v_secret text;
BEGIN
  SELECT s.decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets s WHERE s.name = p_name;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'secret (%) not found', p_name;
  END IF;
  RETURN v_secret;
END;
$$;

CREATE OR REPLACE FUNCTION public.jv_delete_secret(p_name text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = vault, public
AS $$
BEGIN
  PERFORM vault.delete_secret(s.id)
    FROM vault.decrypted_secrets s WHERE s.name = p_name;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.jv_write_secret(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jv_read_secret(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jv_delete_secret(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.jv_write_secret(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.jv_read_secret(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.jv_delete_secret(text) TO service_role;

-- ============================================================
-- 6. PREFERENCE MATCH (semantic-ish retrieval)
--    pg_trgm similarity scoring; no embedding API required.
-- ============================================================
CREATE OR REPLACE FUNCTION public.match_user_preferences(
  p_telegram_chat_id bigint,
  p_query text,
  p_limit integer DEFAULT 5
) RETURNS TABLE (id uuid, preference text, category text, score numeric)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
    SELECT up.id, up.preference, up.category,
           ROUND(public.similarity(up.preference, p_query)::numeric, 3) AS score
      FROM user_preferences up
     WHERE up.telegram_chat_id = p_telegram_chat_id
       AND up.is_active
       AND up.preference % p_query
     ORDER BY score DESC, up.updated_at DESC
     LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.match_user_preferences(bigint, text, integer) TO service_role;

-- ============================================================
-- 7. PROFILES.preferences (Level 3 spec compatibility)
--    The spec calls for a JSONB `preferences` column on profiles;
--    the dedicated user_preferences table above stays the source
--    of truth, this column mirrors it for tooling/analytics.
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'::jsonb;

-- ============================================================
-- 8. CHAT HISTORY CONTEXT MATCH
--    Adaptive-learning context retrieval: fuzzy (pg_trgm) match of
--    the current input against past chat_history rows (no embedding
--    API needed). word_similarity is used because the query is short
--    and stored content is long.
-- ============================================================
CREATE INDEX IF NOT EXISTS chat_history_trgm_idx
  ON chat_history USING gin (content gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.match_chat_history(
  p_telegram_id bigint,
  p_query text,
  p_limit integer DEFAULT 6
) RETURNS TABLE (role text, content text, minutes_ago integer, score numeric)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
    SELECT ch.role, ch.content,
           GREATEST(0, EXTRACT(EPOCH FROM (now() - ch.created_at)) / 60)::integer AS minutes_ago,
           ROUND(public.word_similarity(p_query, ch.content)::numeric, 3) AS score
      FROM chat_history ch
     WHERE ch.telegram_id = p_telegram_id
       AND public.word_similarity(p_query, ch.content) > 0.2
     ORDER BY score DESC, ch.created_at DESC
     LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.match_chat_history(bigint, text, integer) TO service_role;

-- Optional pgvector index on chat_history.embedding. Only creates it when
-- the pgvector extension AND the embedding column actually exist (so the
-- script stays green on projects without them).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'chat_history' AND column_name = 'embedding') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS chat_history_embedding_idx
             ON chat_history USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
  END IF;
END $$;

-- ============================================================
-- 9. OPTIONAL pg_cron SCHEDULE (skip if using GitHub Actions)
--    Calls the Vercel autonomous trigger every 15 minutes.
--    CRON_SECRET must already exist as an environment variable on Vercel.
--    Requires pg_net:
--    CREATE EXTENSION IF NOT EXISTS pg_net;
-- ============================================================
-- SELECT cron.schedule(
--   'jarvis-autonomy-trigger',
--   '*/15 * * * *',
--   'select net.http_post(
--       url := ''https://jarvis-sigma-navy.vercel.app/api/cron-trigger'',
--       headers := jsonb_build_object(
--         ''Content-Type'', ''application/json'',
--         ''Authorization'', ''Bearer '' || current_setting(''app.cron_secret'', true)
--       ),
--       body := ''{}''::bytea
--     )'
-- );

-- ============================================================
-- DONE. Next: see README-AUTONOMY notes in the repo (or ask the bot).
-- ============================================================