-- ============================================================
-- J.A.R.V.I.S. search cache (Tavily/DDG results)
-- Run this in the Supabase SQL Editor.
-- ============================================================
CREATE TABLE IF NOT EXISTS search_cache (
  query TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE search_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "search_cache: service access" ON search_cache;
CREATE POLICY "search_cache: service access"
  ON search_cache FOR ALL
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON search_cache TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON search_cache TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON search_cache TO authenticated;
