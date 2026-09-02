-- ============================================================
-- J.A.R.V.I.S. TODO / reminder list
-- Run this in the Supabase SQL Editor.
-- ============================================================
CREATE TABLE IF NOT EXISTS todos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done')),
  created_at TIMESTAMPTZ DEFAULT now(),
  done_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS todos_telegram_idx ON todos (telegram_id);
CREATE INDEX IF NOT EXISTS todos_status_idx ON todos (telegram_id, status);

ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Todos: service-role access"
  ON todos FOR ALL
  USING (true)
  WITH CHECK (true);

-- PostgREST needs explicit privileges even where RLS is bypassed by the
-- service key; default privileges may not cover brand-new tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO authenticated;