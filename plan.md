# RAG Chatbot — Implementation Plan

## Context

Build a production-ready Retrieval-Augmented Generation chatbot on top of an existing Vite + React + TypeScript scaffold. The frontend is currently the default Vite template; the backend/ directory is an empty Node.js skeleton. The goal is a complete RAG system where:
- Users ingest PDF/DOCX documents locally (Node.js CLI)
- Documents are stored as vector embeddings in Supabase (pgvector)
- A Supabase Edge Function handles query embedding + vector search + streamed LLM response
- The React UI provides a chat interface with source attribution

**User decisions:** Llama 3.1 8B free tier via OpenRouter · `backend/` repurposed as `ingestion/` · Supabase project already exists · Features: caching, rate limiting, document sidebar (no dark mode toggle needed — auto via system preference)

---

## Final Directory Structure

```
openai-rag-chatbot/
├── frontend/                          # Vite + React 19 + TypeScript (existing)
│   ├── .env.local                     # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY  [NEW]
│   ├── index.html                     # update <title>  [EDIT]
│   ├── package.json                   # add: @supabase/supabase-js, react-markdown  [EDIT]
│   └── src/
│       ├── main.tsx                   # unchanged
│       ├── index.css                  # full replace — chat UI globals  [REPLACE]
│       ├── App.tsx                    # full replace — layout + sidebar  [REPLACE]
│       ├── lib/supabase.ts            # Supabase anon client  [NEW]
│       ├── types/index.ts             # Message, Document, Source types  [NEW]
│       ├── hooks/useChat.ts           # streaming fetch + state  [NEW]
│       └── components/
│           ├── ChatWindow.tsx         [NEW]
│           ├── MessageBubble.tsx      [NEW]
│           ├── ChatInput.tsx          [NEW]
│           └── SourceBadge.tsx        [NEW]
│
├── ingestion/                         # repurposed from backend/
│   ├── .env                           # OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  [NEW]
│   ├── .gitignore                     # ignore .env  [NEW]
│   ├── package.json                   # full replace with ingestion deps  [REPLACE]
│   └── src/
│       ├── index.js                   # CLI entry point (commander + progress)  [NEW]
│       ├── chunker.js                 # token-aware chunker (512 tok / 100 overlap)  [NEW]
│       ├── embedder.js                # batched OpenAI embeddings + retry  [NEW]
│       ├── store.js                   # Supabase upsert with dedup  [NEW]
│       └── parsers/
│           ├── pdf.js                 # pdf-parse extractor  [NEW]
│           └── word.js                # mammoth DOCX extractor  [NEW]
│
└── supabase/
    ├── migrations/
    │   └── 20240101000000_rag_schema.sql   [NEW]
    └── functions/
        └── chat/
            └── index.ts               # Deno Edge Function  [NEW]
```

---

## Step 1 — Database Schema

**File:** `supabase/migrations/20240101000000_rag_schema.sql`

```sql
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

CREATE TABLE public.documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  source_type  TEXT NOT NULL CHECK (source_type IN ('pdf', 'docx')),
  file_hash    TEXT NOT NULL UNIQUE,   -- SHA-256 for re-ingestion dedup
  page_count   INT,
  char_count   INT,
  chunk_count  INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.document_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  chunk_index   INT NOT NULL,
  content       TEXT NOT NULL,
  token_count   INT NOT NULL,
  embedding     vector(1536),          -- text-embedding-3-small dimensions
  content_hash  TEXT NOT NULL,         -- SHA-256 for chunk-level dedup
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(document_id, chunk_index)
);

-- IVFFlat index; lists=100 suits up to ~1M rows
CREATE INDEX ON public.document_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX ON public.document_chunks (content_hash);
CREATE INDEX ON public.document_chunks (document_id);

-- RPC used by Edge Function for vector search
CREATE OR REPLACE FUNCTION public.match_chunks(
  query_embedding   vector(1536),
  match_threshold   float DEFAULT 0.7,
  match_count       int   DEFAULT 5
)
RETURNS TABLE (
  id UUID, document_id UUID, chunk_index INT,
  content TEXT, token_count INT, similarity float, document_name TEXT
)
LANGUAGE sql STABLE AS $$
  SELECT dc.id, dc.document_id, dc.chunk_index, dc.content, dc.token_count,
         1 - (dc.embedding <=> query_embedding) AS similarity,
         d.name AS document_name
  FROM public.document_chunks dc
  JOIN public.documents d ON d.id = dc.document_id
  WHERE 1 - (dc.embedding <=> query_embedding) > match_threshold
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- RLS: anon can read documents list (sidebar); chunks are internal only
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read documents" ON public.documents FOR SELECT USING (true);
-- No chunk SELECT policy for anon — Edge Function uses service role key
```

Apply: `supabase db push`

---

## Step 2 — Ingestion Script (repurpose `backend/` → `ingestion/`)

Replace `backend/package.json` and `backend/index.js`, create `ingestion/src/` structure.

### `ingestion/package.json`
```json
{
  "name": "rag-ingestion",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "ingest": "node src/index.js" },
  "dependencies": {
    "@supabase/supabase-js": "^2.49.0",
    "cli-progress": "^3.12.0",
    "commander": "^12.0.0",
    "dotenv": "^16.4.5",
    "js-tiktoken": "^1.0.15",
    "mammoth": "^1.7.2",
    "openai": "^4.52.0",
    "pdf-parse": "^1.1.1"
  }
}
```

### `ingestion/src/parsers/pdf.js`
- `import pdfParse from 'pdf-parse'`; read file buffer → return `{ text, pageCount }`

### `ingestion/src/parsers/word.js`
- `mammoth.extractRawText({ path })` → return `{ text, pageCount: null }`

### `ingestion/src/chunker.js` (key logic)
- Use `js-tiktoken` with `cl100k_base` encoding
- Split on sentence boundaries (`.?!\n\n` regex)
- Greedy accumulate sentences up to **512 tokens**; slide back **100 tokens** of overlap
- Return `[{ content: string, tokenCount: number }]`
- Call `enc.free()` after to release WASM memory

### `ingestion/src/embedder.js`
- Batch chunks into groups of **100** (OpenAI batch limit)
- `client.embeddings.create({ model: 'text-embedding-3-small', input: batch })`
- Exponential backoff retry on 429 (1s, 2s, 4s)
- Return `float[][]` in input order

### `ingestion/src/store.js`
- `createClient(url, serviceRoleKey, { auth: { persistSession: false } })`
- `upsertDocument`: check `file_hash` UNIQUE — skip entire file if already ingested
- `storeChunks`: serialize embedding as `[${floats.join(',')}]` (pgvector literal); batch upsert 100 rows at a time with `onConflict: 'content_hash', ignoreDuplicates: true`

### `ingestion/src/index.js`
- `commander` CLI: `node src/index.js <files...> [--dry-run] [--verbose]`
- Validate env vars on startup; error-exit if missing
- Per-file flow: parse → hash check → chunk → (skip embed if dry-run) → upsertDocument → embedChunks → storeChunks
- `cli-progress` MultiBar showing Chunking / Embedding / Storing phases

**Usage:**
```bash
cd ingestion && npm install
node src/index.js ../docs/report.pdf ../docs/manual.docx
node src/index.js ../docs/test.pdf --dry-run   # no API calls
```

---

## Step 3 — Supabase Edge Function

**File:** `supabase/functions/chat/index.ts` (Deno TypeScript)

**Env vars needed:**
```bash
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set OPENROUTER_API_KEY=sk-or-...
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase runtime
```

**Flow:**
1. CORS preflight → 204
2. Parse body: `{ query: string, history: Message[] }`
3. **Rate limit**: per-IP token bucket, 20 req/min; return 429 if exceeded
4. **Query embedding cache**: `Map<normalizedQuery, { embedding, timestamp }>`, 5-min TTL, 200-entry LRU eviction
5. If cache miss: `POST https://api.openai.com/v1/embeddings` with `text-embedding-3-small`
6. `supabase.rpc('match_chunks', { query_embedding, match_threshold: 0.7, match_count: 5 })`
7. Build system prompt with retrieved context blocks + **strict RAG rules** (answer ONLY from context; fallback: "I don't have information about that in the documents.")
8. Emit `event: sources\ndata: {"sources": [...names]}\n\n` first (before LLM stream)
9. `POST https://openrouter.ai/api/v1/chat/completions` with `stream: true, temperature: 0.1, max_tokens: 1024, model: "meta-llama/llama-3.1-8b-instruct:free"`
10. Pipe OpenRouter SSE → `TransformStream` → client
11. End with `data: [DONE]\n\n`

**Response headers:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`

**Deploy:**
```bash
supabase functions deploy chat --no-verify-jwt
```

---

## Step 4 — Frontend

### Install deps
```bash
cd frontend
npm install @supabase/supabase-js react-markdown
```

### `frontend/.env.local`
```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

### `frontend/src/lib/supabase.ts`
Single shared client using `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`; throws on missing env.

### `frontend/src/types/index.ts`
```typescript
export interface Message { id: string; role: 'user'|'assistant'; content: string; sources?: {name:string}[]; isStreaming?: boolean; error?: boolean }
export interface Document { id: string; name: string; source_type: 'pdf'|'docx'; chunk_count: number; created_at: string }
```

### `frontend/src/hooks/useChat.ts` (streaming core)
- State: `messages: Message[]`, `isLoading: boolean`
- `AbortController` ref to cancel in-flight streams
- On `sendMessage(query)`:
  1. Append user message + empty streaming assistant message
  2. `fetch(EDGE_FUNCTION_URL, { method:'POST', headers: { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY } })`
  3. Read `response.body.getReader()` + `TextDecoder` line-by-line
  4. Parse `event: sources` → store sources array
  5. Parse `data: {...}` → extract `choices[0].delta.content` → append to assistant message via `setMessages`
  6. On `[DONE]`: mark `isStreaming: false`, attach sources
  7. On network error: mark `error: true`
- Expose `clearMessages()` which aborts and resets

### `frontend/src/components/ChatWindow.tsx`
Scrollable `role="log"` div; `useEffect` auto-scrolls to bottom on `messages.length` or last message content change. Shows empty-state prompt when no messages.

### `frontend/src/components/MessageBubble.tsx`
- User: plain `<p>` in blue bubble (right-aligned)
- Assistant: `<ReactMarkdown>` + blinking cursor during `isStreaming`, source badges below when complete

### `frontend/src/components/ChatInput.tsx`
- `<textarea>` with `field-sizing: content` (auto-grow)
- `Enter` → submit; `Shift+Enter` → newline
- Disabled + spinner icon while `isLoading`

### `frontend/src/components/SourceBadge.tsx`
Small pill badge with document icon + filename, `max-width: 200px` overflow ellipsis.

### `frontend/src/App.tsx`
Two-panel layout: collapsible sidebar (260px) + main chat area. Sidebar fetches `documents` table on mount via Supabase client, shows name / type badge / chunk count. Header has "Clear chat" button. Auto dark/light via CSS `prefers-color-scheme`.

### `frontend/src/index.css`
Full replacement: CSS custom properties for light/dark, flex app layout, bubble styles, streaming cursor blink animation, source badge, chat input area, spinner keyframe, responsive breakpoint at 640px.

### `frontend/index.html`
Change `<title>` to `RAG Chatbot`.

---

## Step 5 — Scalability & Performance

| Concern | Solution |
|---------|----------|
| Repeated identical queries | In-memory embedding cache in Edge Function (Map, 5-min TTL) |
| Abuse / cost runaway | Per-IP rate limit (20 req/min token bucket) in Edge Function |
| Re-ingesting same file | `file_hash` UNIQUE on `documents` — skip before any API calls |
| Duplicate chunks | `content_hash` upsert with `ignoreDuplicates` |
| Large corpora | IVFFlat `lists=100`; increase to 1000 for >1M rows |
| Perceived latency | SSE streaming; first token visible in ~700ms |
| Model upgrade path | Single `CHAT_MODEL` constant in Edge Function |

---

## Verification

### Database
```sql
-- After migration:
\d public.documents
\d public.document_chunks
SELECT * FROM match_chunks(array_fill(0.01::float, ARRAY[1536])::vector, 0.0, 3);
```

### Ingestion
```bash
node src/index.js test.pdf --dry-run          # parsing + chunking only
node src/index.js test.pdf                    # full run
node src/index.js test.pdf                    # re-run → "already ingested, skipping"
```

### Edge Function (local)
```bash
supabase functions serve chat --env-file supabase/.env.local
curl -X POST http://localhost:54321/functions/v1/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -d '{"query":"What is the main topic?","history":[]}' --no-buffer
```
Expected: `event: sources` SSE, then `data: {...delta...}` lines, then `data: [DONE]`.

### Frontend checklist
- [ ] Sidebar shows ingested documents
- [ ] Typing + Enter streams response with blinking cursor
- [ ] Source badges appear after stream completes
- [ ] Out-of-context question → "I don't have information about that in the documents."
- [ ] Shift+Enter inserts newline; input disabled during streaming
- [ ] Clear chat aborts in-progress stream

---

## Sequencing

| # | Action | Where |
|---|--------|-------|
| 1 | Apply SQL migration | `supabase db push` |
| 2 | Repurpose `backend/` → `ingestion/` (replace package.json + write src/) | `ingestion/` |
| 3 | `npm install` in ingestion | `ingestion/` |
| 4 | Ingest test documents | `node src/index.js` |
| 5 | Write Edge Function | `supabase/functions/chat/index.ts` |
| 6 | Set secrets + deploy Edge Function | `supabase secrets set` + `supabase functions deploy` |
| 7 | Install frontend deps | `cd frontend && npm install` |
| 8 | Write all frontend files (types → lib → hooks → components → App → CSS) | `frontend/src/` |
| 9 | Create `frontend/.env.local` | `frontend/` |
| 10 | Test with `npm run dev` | `frontend/` |
| 11 | `npm run build` to verify TypeScript + bundle | `frontend/` |