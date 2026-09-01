-- ============================================================
-- J.A.R.V.I.S. RAG / Knowledge Base schema
-- Run this in the Supabase SQL Editor (after sql/schema.sql).
-- Keyword-first retrieval for now; vector embeddings can be added
-- later without breaking this schema.
-- ============================================================

-- Trigram index support for keyword / similarity search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Documents metadata
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Chunks of each document (for retrieval)
CREATE TABLE IF NOT EXISTS document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INT,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for faster keyword search
CREATE INDEX IF NOT EXISTS document_chunks_content_trgm_idx
  ON document_chunks USING gin (content gin_trgm_ops);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;

-- Allow the backend service_role (which talks to PostgREST) full access.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
