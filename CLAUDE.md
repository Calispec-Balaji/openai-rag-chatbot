# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Production-ready RAG (Retrieval-Augmented Generation) chatbot that answers questions exclusively from user-uploaded documents (PDF/DOCX). The system is designed to prevent hallucinations by strictly limiting LLM responses to ingested document context.

## Architecture

Three independent subsystems that never share runtime processes:

```
backend/        → Local Node.js CLI (document ingestion, never deployed)
frontend/       → React 19 + Vite SPA (chat UI, deployed statically)
supabase/       → Postgres schema + Deno Edge Function (serverless inference)
```

**Data flow:**
1. Documents → `backend/` CLI → OpenAI embeddings → Supabase pgvector
2. User query → `frontend/` → Supabase Edge Function → OpenRouter LLM → SSE stream back

**Key design decisions:**
- The backend is a local CLI only — no ingestion server is deployed
- Chat inference runs entirely in a Supabase Edge Function (Deno runtime)
- LLM is accessed via OpenRouter (`meta-llama/llama-3.1-8b-instruct:free` by default) — change via `CHAT_MODEL` constant in `supabase/functions/chat/index.ts`
- Embeddings use OpenAI `text-embedding-3-small` (1536d vectors)
- The frontend uses the Supabase anon key — RLS policies ensure chunks are only readable via service role (Edge Function), not the browser

## Commands

### Frontend
```bash
cd frontend
npm install
npm run dev          # Vite dev server → http://localhost:5173
npm run build        # TypeScript check + Vite production build → dist/
npm run preview      # Preview production build locally
npm run lint         # ESLint
```

### Backend (Ingestion CLI)
```bash
cd backend
npm install
node src/index.js report.pdf manual.docx     # Ingest files
node src/index.js report.pdf --dry-run       # Parse + chunk without API calls
node src/index.js report.pdf --verbose       # Print chunk previews
npm run ingest                                # Alias for node src/index.js
npm run ingest:watch                         # Watch mode (nodemon)
```

### Database
```bash
supabase link --project-ref <PROJECT_REF>
supabase db push                              # Apply migrations in supabase/migrations/
```

### Edge Function
```bash
# Local dev
supabase functions serve chat --env-file supabase/.env.local

# Deploy
supabase secrets set OPENAI_API_KEY=sk-... OPENROUTER_API_KEY=sk-or-...
supabase functions deploy chat --no-verify-jwt

# Test locally
curl -X POST http://localhost:54321/functions/v1/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -d '{"query":"What is the main topic?","history":[]}' --no-buffer
```

## Environment Variables

**`backend/.env`** (never deployed):
```
OPENAI_API_KEY=           # Embeddings
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=   # Bypasses RLS for chunk writes
```

**`frontend/.env.local`**:
```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=      # Safe in browser — RLS restricts chunk access
```

**Edge Function secrets** (set via `supabase secrets set`):
```
OPENAI_API_KEY=              # Query embedding at inference time
OPENROUTER_API_KEY=          # Chat completions
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase runtime
```

## Key Files

| File | Role |
|------|------|
| `supabase/functions/chat/index.ts` | Edge Function: rate limiting (20 req/min token bucket), query embedding cache (5-min LRU), vector search, RAG prompt, SSE streaming |
| `supabase/migrations/20240101000000_rag_schema.sql` | Full DB schema: `documents`, `document_chunks`, IVFFlat index, `match_chunks` RPC, RLS policies |
| `backend/src/chunker.js` | Token-aware chunking: 512 tokens/chunk, 100 token overlap, sentence-boundary splitting via `js-tiktoken` |
| `backend/src/embedder.js` | Batched OpenAI embeddings (100/batch) with exponential backoff |
| `backend/src/store.js` | Supabase upsert with dual deduplication: file-level SHA-256 + chunk-level content hash |
| `frontend/src/hooks/useChat.ts` | SSE streaming hook: parses `event: sources` first, then accumulates `data:` tokens into assistant message |
| `frontend/src/App.tsx` | Two-panel layout: collapsible document sidebar + chat area |

## Database Schema Notes

- `documents` table: file metadata + `file_hash` UNIQUE constraint (prevents re-ingestion)
- `document_chunks` table: `embedding vector(1536)` + `content_hash` UNIQUE (chunk-level dedup)
- `match_chunks` RPC: cosine similarity search, default threshold 0.7, returns top 5 chunks
- IVFFlat index uses `lists=100` — requires at least 100 documents for optimal performance

## Streaming Protocol (SSE)

The Edge Function emits events in this order:
1. `event: sources\ndata: [{id, name, source_type}]\n\n` — source documents
2. `data: <token>\n\n` — streamed LLM tokens
3. `data: [DONE]\n\n` — end signal

The frontend `useChat.ts` hook handles this sequence to attach sources to the final assistant message.
