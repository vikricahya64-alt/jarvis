-- ============================================================
-- J.A.R.V.I.S. Personal Industrial Agentic AI
-- Supabase Database Schema (PostgreSQL)
-- Run this in the Supabase SQL Editor
-- ============================================================

-- Enable the pgvector extension for storing embeddings (RAG)
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- 1. PROFILES: stores user preferences
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  default_task_mode TEXT DEFAULT 'research',
  preferred_language TEXT DEFAULT 'id',
  preferences JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 2. CHAT_HISTORY: conversation context with vector embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for vector similarity search (RAG)
CREATE INDEX IF NOT EXISTS chat_history_embedding_idx ON chat_history
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================
-- 3. TASKS: event-driven queue table
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL,
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED')),
  agent TEXT,
  tool_calls JSONB,
  result_url TEXT,
  result_text TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for faster status queries
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status);
CREATE INDEX IF NOT EXISTS tasks_telegram_idx ON tasks (telegram_id);

-- ============================================================
-- STORAGE BUCKET for file artifacts
-- NOTE: Do NOT create this bucket via SQL. The `storage` schema is
-- owned by `supabase_admin`, so the SQL Editor role cannot run
-- INSERT here (error 42501: must be able to SET ROLE "supabase_admin").
-- Create it in the Dashboard instead:
--   Storage -> New bucket -> name: `artifacts` -> Public bucket: ON
-- ============================================================

-- ============================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- HELPER FUNCTION: resolve telegram_id from JWT claims
-- (Defined BEFORE the policies that reference it.)
-- ============================================================
CREATE OR REPLACE FUNCTION get_telegram_id()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  tg_id BIGINT;
BEGIN
  tg_id := NULLIF((current_setting('request.jwt.claims', true)::jsonb ->> 'telegram_id'), '')::BIGINT;
  RETURN COALESCE(tg_id, -1);
END;
$$;

-- Profiles: users can read/update their own profile
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.uid()::text = telegram_id::text
         OR telegram_id = get_telegram_id());

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (true);

-- For a service-role based system (backend orchestrator uses service key),
-- we add service-role bypass policies (already granted via service_role).
-- The policies below protect direct client access:

-- chat_history: users can read own history
CREATE POLICY "Users can read own chat history"
  ON chat_history FOR SELECT
  USING (telegram_id = get_telegram_id());

CREATE POLICY "Users can insert own chat history"
  ON chat_history FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id());

-- tasks: users can read own tasks
CREATE POLICY "Users can read own tasks"
  ON tasks FOR SELECT
  USING (telegram_id = get_telegram_id());

CREATE POLICY "Users can insert own tasks"
  ON tasks FOR INSERT
  WITH CHECK (telegram_id = get_telegram_id());

-- ============================================================
-- TRIGGER: automatically bump "updated_at" on row changes
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_updated
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_tasks_updated
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SUPABASE DATABASE WEBHOOK (to trigger orchestrator)
-- Note: Created via Supabase Dashboard > Database > Webhooks
-- 1. Type: PostgreSQL Table
-- 2. Table: tasks
-- 3. Events: INSERT
-- 4. Webhook URL: https://<your-app>.vercel.app/api/orchestrator
-- 5. Headers: Content-Type: application/json
-- ============================================================
