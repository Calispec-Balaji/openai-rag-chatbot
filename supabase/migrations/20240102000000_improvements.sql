-- Drop old misconfigured IVFFlat index (lists=100 is wrong for 135 chunks)
DROP INDEX IF EXISTS document_chunks_embedding_idx;

-- HNSW: better accuracy and performance for small-medium datasets
CREATE INDEX document_chunks_embedding_hnsw_idx
  ON public.document_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Hybrid search: generated tsvector column (auto-populates existing and new rows)
ALTER TABLE public.document_chunks
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

-- GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS document_chunks_fts_idx
  ON public.document_chunks USING gin (search_vector);

-- Replace match_chunks RPC with hybrid RRF (Reciprocal Rank Fusion) version.
-- Combines vector similarity + full-text search so exact terms and semantic
-- queries both retrieve the right chunks.
CREATE OR REPLACE FUNCTION public.match_chunks(
  query_embedding  vector(1536),
  query_text       text    DEFAULT '',
  match_threshold  float   DEFAULT 0.65,
  match_count      int     DEFAULT 12
)
RETURNS TABLE (
  id            UUID,
  document_id   UUID,
  chunk_index   INT,
  content       TEXT,
  token_count   INT,
  similarity    float,
  document_name TEXT
)
LANGUAGE sql STABLE AS $$
  WITH vector_ranked AS (
    SELECT dc.id,
           ROW_NUMBER() OVER (ORDER BY dc.embedding <=> query_embedding) AS rank,
           1 - (dc.embedding <=> query_embedding) AS sim
    FROM public.document_chunks dc
    WHERE 1 - (dc.embedding <=> query_embedding) >= match_threshold
    LIMIT match_count * 3
  ),
  fts_ranked AS (
    SELECT dc.id,
           ROW_NUMBER() OVER (
             ORDER BY ts_rank_cd(dc.search_vector,
                        plainto_tsquery('english', query_text)) DESC
           ) AS rank
    FROM public.document_chunks dc
    WHERE query_text <> ''
      AND dc.search_vector @@ plainto_tsquery('english', query_text)
    LIMIT match_count * 3
  ),
  combined AS (
    SELECT COALESCE(v.id, f.id)                                          AS id,
           COALESCE(v.sim, 0)                                            AS similarity,
           COALESCE(1.0 / (60 + v.rank), 0) + COALESCE(1.0 / (60 + f.rank), 0) AS rrf_score
    FROM vector_ranked v
    FULL OUTER JOIN fts_ranked f ON v.id = f.id
  )
  SELECT dc.id, dc.document_id, dc.chunk_index, dc.content, dc.token_count,
         c.similarity, d.name AS document_name
  FROM combined c
  JOIN public.document_chunks dc ON dc.id = c.id
  JOIN public.documents d ON d.id = dc.document_id
  ORDER BY c.rrf_score DESC
  LIMIT match_count;
$$;
