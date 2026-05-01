-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- ============================================================
-- documents: one row per ingested file
-- ============================================================
CREATE TABLE public.documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  source_type  TEXT NOT NULL CHECK (source_type IN ('pdf', 'docx')),
  file_hash    TEXT NOT NULL UNIQUE,  -- SHA-256 of raw file bytes; prevents re-ingestion
  page_count   INT,
  char_count   INT,
  chunk_count  INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- document_chunks: one row per text chunk + its embedding
-- ============================================================
CREATE TABLE public.document_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  chunk_index   INT NOT NULL,                 -- 0-based sequential index within document
  content       TEXT NOT NULL,               -- raw chunk text sent to LLM as context
  token_count   INT NOT NULL,                -- tiktoken count (cl100k_base)
  embedding     vector(1536),                -- text-embedding-3-small output
  content_hash  TEXT NOT NULL,               -- SHA-256 of chunk content for dedup
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(document_id, chunk_index)
);

-- IVFFlat index for fast approximate nearest-neighbour search
-- lists=100 is appropriate for up to ~1M rows; increase to 1000 for larger corpora
CREATE INDEX ON public.document_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Supporting indexes for ingestion dedup and cascade lookups
CREATE INDEX ON public.document_chunks (content_hash);
CREATE INDEX ON public.document_chunks (document_id);

-- ============================================================
-- match_chunks: RPC called by the Edge Function
-- Returns top-N chunks above a cosine similarity threshold
-- ============================================================
CREATE OR REPLACE FUNCTION public.match_chunks(
  query_embedding   vector(1536),
  match_threshold   float DEFAULT 0.7,
  match_count       int   DEFAULT 5
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
LANGUAGE sql STABLE
AS $$
  SELECT
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    dc.token_count,
    1 - (dc.embedding <=> query_embedding) AS similarity,
    d.name AS document_name
  FROM public.document_chunks dc
  JOIN public.documents d ON d.id = dc.document_id
  WHERE 1 - (dc.embedding <=> query_embedding) > match_threshold
  ORDER BY dc.embedding <=> query_embedding   -- ascending distance = descending similarity
  LIMIT match_count;
$$;

-- ============================================================
-- Row Level Security
-- Anon (browser) can read documents list (for sidebar).
-- Chunks are internal — only accessible via the Edge Function
-- which runs with the service role key (bypasses RLS).
-- ============================================================
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read documents"
  ON public.documents
  FOR SELECT
  USING (true);

-- No INSERT/UPDATE/DELETE policy for anon = denied by default
-- No SELECT policy on document_chunks for anon = denied by default
-- Service role key bypasses RLS entirely (used by ingestion + Edge Function)
