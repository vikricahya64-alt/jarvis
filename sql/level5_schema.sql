-- ============================================================
-- J.A.R.V.I.S. LEVEL 5: SENTIENT ECOSYSTEM SCHEMA
-- Behavioral pattern mining, predictive triggers, emotional context,
-- cross-platform synthesis, and reversible self-evolution.
--
-- Run this in the Supabase SQL Editor. Idempotent (safe to re-run).
-- Notes:
--   * profiles gain JSONB columns that hold ONLY aggregates/patterns
--     (differential privacy: never raw user messages here).
--   * synthesized_insights is a new table for cross-platform insight
--     cards, with TTL cleanup so it never grows unbounded on free tier.
--   * v_user_behavioral_patterns is a 30-day behavioral window over
--     tasks + chat_history (tasks has NO user_message column, so we
--     read tasks.input; topics can be clustered later via embedding).
--   * All read/write is RLS-respecting via get_telegram_id().
-- ============================================================

-- ------------------------------------------------------------------
-- 1. PROFILES: Level-5 JSONB columns (aggregates only, no raw messages)
-- ------------------------------------------------------------------
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS behavior_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS emotional_trends JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS evolution_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS service_consent JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Value-level GIN indexes let us query inside the JSON aggregates cheaply
-- (e.g. filter users by consent flags or by a behavior bucket).
CREATE INDEX IF NOT EXISTS profiles_behavior_idx ON profiles USING GIN (behavior_profile);
CREATE INDEX IF NOT EXISTS profiles_consent_idx  ON profiles USING GIN (service_consent);

-- ------------------------------------------------------------------
-- 2. SYNTHESIZED INSIGHTS: cross-platform / predictive insight cards
--    TTL: expired rows are cleaned by a maintenance routine (see cron /
--    docs). `payload` carries the card text + source + expiry + priority.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.synthesized_insights (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id   bigint      NOT NULL,
    insight_type  text        NOT NULL,          -- 'predictive' | 'synthesis'
    payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    priority      int         NOT NULL DEFAULT 0,
    dismissed     boolean     NOT NULL DEFAULT false,
    acted_on      boolean     NOT NULL DEFAULT false,
    expires_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS synthesized_insights_owner_idx
  ON synthesized_insights (telegram_id, dismissed, expires_at);
CREATE INDEX IF NOT EXISTS synthesized_insights_tty_idx
  ON synthesized_insights (expires_at);   -- for TTL cleanup

-- ------------------------------------------------------------------
-- 3. BEHAVIORAL PATTERN VIEW: 30-day aggregate window per user.
--    No `user_message` column exists on tasks, so behavior is derived
--    from the actual signals we DO have: task inputs, agent routing,
--    timestamps, and the running counts. Topic clustering may be layered
--    on later through chat_history.embedding.
-- ------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_user_behavioral_patterns AS
SELECT
    t.telegram_id                                                                  AS telegram_id,
    date_trunc('day', t.created_at)                                                AS activity_day,
    count(*)                                                                       AS task_count,
    count(*) FILTER (WHERE t.status = 'DONE')                                      AS done_count,
    count(*) FILTER (WHERE t.status = 'FAILED')                                    AS failed_count,
    count(*) FILTER (WHERE t.agent_type IS NOT NULL)                               AS child_agent_tasks,
    coalesce(mode() WITHIN GROUP (ORDER BY t.agent_type), 'main')                  AS dominant_agent,
    array_agg(DISTINCT left(coalesce(t.input, ''), 1))                             AS input_start_chars,
    max(t.created_at)                                                              AS last_activity_at
  FROM tasks t
 WHERE t.created_at >= now() - interval '30 days'
 GROUP BY t.telegram_id, date_trunc('day', t.created_at);

GRANT SELECT ON public.v_user_behavioral_patterns TO service_role;

-- ------------------------------------------------------------------
-- 4. RLS for synthesized_insights + profiles Level-5 columns.
--    Service role bypasses RLS; the policies below cover the
--    authenticated path (same get_telegram_id() helper as schema.sql).
-- ------------------------------------------------------------------
ALTER TABLE public.synthesized_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can select own insights" ON public.synthesized_insights;
CREATE POLICY "Users can select own insights"
  ON public.synthesized_insights FOR SELECT
  USING (telegram_id = get_telegram_id());

DROP POLICY IF EXISTS "Users can update own insights" ON public.synthesized_insights;
CREATE POLICY "Users can update own insights"
  ON public.synthesized_insights FOR UPDATE
  USING (telegram_id = get_telegram_id());

DROP POLICY IF EXISTS "Users can insert own insights" ON public.synthesized_insights;
CREATE POLICY "Users can insert own insights"
  ON public.synthesized_insights FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id());

-- Owners may update their own Level-5 profile aggregates.
DROP POLICY IF EXISTS "Users can update own profile aggregates" ON profiles;
CREATE POLICY "Users can update own profile aggregates"
  ON profiles FOR UPDATE
  USING (telegram_id = get_telegram_id());

-- Service role performs background writes (TTL cleanup, ingestion);
-- explicit grants so any privileged path can manage insights.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.synthesized_insights TO service_role;

-- ============================================================
-- DONE. Next: see docs/level5-setup.md for deployment steps.
-- ============================================================
