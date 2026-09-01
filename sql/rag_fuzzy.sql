-- ============================================================
-- J.A.R.V.I.S. fuzzy / typo-tolerant search (pg_trgm)
-- Run this in the Supabase SQL Editor AFTER sql/rag_schema.sql.
-- Adds an index-backed fuzzy search used by the retrieve_docs
-- tool (word_similarity + <%). The app falls back to plain ILIKE
-- if this function does not exist yet.
-- ============================================================

CREATE OR REPLACE FUNCTION search_document_chunks(p_query text, p_top_k int DEFAULT 5)
RETURNS TABLE(
  chunk_id uuid,
  doc_id   uuid,
  title    text,
  content  text,
  score    double precision,
  hits     bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH tokens AS (
    SELECT tok
    FROM unnest(regexp_split_to_array(lower(trim(p_query)), '\W+')) AS tok
    WHERE length(tok) >= 3
  ),
  candidates AS (
    SELECT
      c.id            AS chunk_id,
      c.document_id   AS doc_id,
      d.title         AS title,
      c.content       AS content,
      -- explicit word_similarity with a fixed threshold: not affected by
      -- pg_trgm.word_similarity_threshold GUC (Supabase sets it to 0.6),
      -- and set high enough to reject false positives from 1-2 shared
      -- trigrams (0.3 matched e.g. "caroubik" vs "cari").
      word_similarity(t.tok, c.content) AS per_score
    FROM tokens t
    JOIN document_chunks c ON word_similarity(t.tok, c.content) >= 0.4::real
    JOIN documents d      ON d.id = c.document_id
  ),
  scored AS (
    SELECT
      chunk_id,
      doc_id,
      title,
      content,
      MAX(per_score) AS score,
      COUNT(*)       AS hits
    FROM candidates
    GROUP BY chunk_id, doc_id, title, content
  )
  SELECT
    chunk_id,
    doc_id,
    title::text,
    content::text,
    score::double precision,
    hits::bigint
  FROM scored
  ORDER BY score DESC, hits DESC
  LIMIT p_top_k;
$$;

GRANT EXECUTE ON FUNCTION search_document_chunks(text, int)
  TO service_role, anon, authenticated, public;
GRANT USAGE ON SCHEMA public TO service_role;