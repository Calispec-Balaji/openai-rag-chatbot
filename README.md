# RAG Chatbot

A production-ready Retrieval-Augmented Generation (RAG) chatbot that answers questions exclusively from your own documents. Upload PDFs and Word files, and chat with them — no hallucinations, no outside knowledge.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Your Machine                         │
│                                                             │
│  backend/ (Node.js CLI)                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  PDF / DOCX  →  parse  →  chunk  →  embed  →  store  │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────┬───────────────────────────────┘
                              │ service role key
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         Supabase                            │
│                                                             │
│  Postgres + pgvector                                        │
│  ┌─────────────┐    ┌──────────────────────────────────┐    │
│  │  documents  │───▶│  document_chunks  (vector 1536d) │    │
│  └─────────────┘    └──────────────────────────────────┘    │
│                                    ▲                        │
│  Edge Function (Deno)              │ match_chunks RPC       │
│  ┌────────────────────────────┐    │                        │
│  │  embed query  →  search  ──┘    │                        │
│  │  build prompt  →  stream LLM    │                        │
│  └────────────────────────────┘                             │
└──────────────────────────┬──────────────────────────────────┘
                           │ SSE stream
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Browser (React / Vite)                    │
│                                                             │
│  sidebar: document list   │   chat: streaming responses     │
└─────────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- Ingestion runs **locally** — no backend server to host or pay for
- The Edge Function handles only query-time work (embed → search → chat)
- The chatbot answers **only from document context** — strict prompt engineering prevents hallucination
- Streaming SSE delivers the first token in ~700ms

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + Vite + TypeScript |
| Database | Supabase Postgres + pgvector |
| API | Supabase Edge Functions (Deno) |
| Embeddings | OpenAI `text-embedding-3-small` |
| Chat LLM | OpenRouter → `meta-llama/llama-3.1-8b-instruct:free` |
| Ingestion | Local Node.js CLI (no deployment) |

---

## Project Structure

```
openai-rag-chatbot/
├── frontend/                        # React chat UI
│   ├── src/
│   │   ├── App.tsx                  # Layout: sidebar + chat
│   │   ├── hooks/useChat.ts         # Streaming SSE + state
│   │   ├── components/
│   │   │   ├── ChatWindow.tsx
│   │   │   ├── MessageBubble.tsx    # Markdown + source badges
│   │   │   ├── ChatInput.tsx        # Enter to send, Shift+Enter for newline
│   │   │   └── SourceBadge.tsx
│   │   ├── lib/supabase.ts          # Supabase anon client
│   │   └── types/index.ts
│   └── .env.local.example
│
├── backend/                         # Local ingestion CLI (not deployed)
│   ├── src/
│   │   ├── index.js                 # CLI entry point
│   │   ├── chunker.js               # Token-aware text chunking
│   │   ├── embedder.js              # Batched OpenAI embeddings
│   │   ├── store.js                 # Supabase upsert with dedup
│   │   └── parsers/
│   │       ├── pdf.js               # pdf-parse extractor
│   │       └── word.js              # mammoth DOCX extractor
│   └── .env.example
│
└── supabase/
    ├── migrations/
    │   └── 20240101000000_rag_schema.sql   # Schema + pgvector + RPC
    └── functions/
        └── chat/
            └── index.ts             # Edge Function: embed → search → stream
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Supabase CLI](https://supabase.com/docs/guides/cli) — `npm install -g supabase`
- A [Supabase](https://supabase.com) project (free tier works)
- An [OpenAI API key](https://platform.openai.com/api-keys) (for embeddings)
- An [OpenRouter API key](https://openrouter.ai/keys) (for chat — free tier available)

---

## Setup

### 1 — Database

```bash
# Link to your Supabase project
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>

# Apply the schema migration (creates tables, index, RPC function, RLS policies)
supabase db push
```

### 2 — Ingest Documents

```bash
cd backend
npm install

# Copy and fill in your keys
cp .env.example .env
```

Edit `backend/.env`:
```env
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

Run the ingestion script:
```bash
# Ingest one or more files
node src/index.js /path/to/report.pdf /path/to/manual.docx

# Options
node src/index.js report.pdf --dry-run    # parse + chunk only, no API calls
node src/index.js report.pdf --verbose    # print chunk previews
```

> Re-running on the same file is safe — SHA-256 hashing skips already-ingested files.

### 3 — Deploy Edge Function

```bash
# Set secret API keys in Supabase
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set OPENROUTER_API_KEY=sk-or-...

# Deploy the chat Edge Function
supabase functions deploy chat --no-verify-jwt
```

> `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by the Supabase runtime.

### 4 — Frontend

```bash
cd frontend

# Copy and fill in your Supabase public keys
cp .env.local.example .env.local
```

Edit `frontend/.env.local`:
```env
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

```bash
npm install   # already done if you ran it earlier
npm run dev   # open http://localhost:5173
```

---

## Testing Locally

Test the Edge Function before deploying:

```bash
# Serve the Edge Function locally
supabase functions serve chat --env-file supabase/.env.local

# In another terminal, send a test query
curl -X POST http://localhost:54321/functions/v1/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_ANON_KEY>" \
  -d '{"query": "What is the main topic of the documents?", "history": []}' \
  --no-buffer
```

Expected output — a stream of SSE lines:
```
event: sources
data: {"sources":["report.pdf"]}

data: {"choices":[{"delta":{"content":"The main"}}]}
data: {"choices":[{"delta":{"content":" topic"}}]}
...
data: [DONE]
```

---

## Production Deployment

Deploy the frontend to [Vercel](https://vercel.com) or [Netlify](https://netlify.com):

```bash
cd frontend
npm run build   # outputs to dist/
```

After deploying, update the `HTTP-Referer` header in `supabase/functions/chat/index.ts` to your production domain, and tighten the `Access-Control-Allow-Origin` CORS header.

---

## Model Options

### Embeddings
| Model | Dimensions | Cost | Notes |
|-------|-----------|------|-------|
| `text-embedding-3-small` ✓ | 1536 | $0.02 / 1M tokens | Default — best value |
| `text-embedding-3-large` | 3072 | $0.13 / 1M tokens | Higher accuracy, larger index |

### Chat (via OpenRouter)
| Model | Cost | Notes |
|-------|------|-------|
| `meta-llama/llama-3.1-8b-instruct:free` ✓ | Free | Default |
| `google/gemma-3-12b-it:free` | Free | Alternative free option |
| `google/gemini-flash-1.5` | $0.075 / 1M | Budget paid |
| `openai/gpt-4o-mini` | $0.15 / 1M | Best value paid |
| `anthropic/claude-3-5-haiku` | $0.80 / 1M | High quality |

To swap models, change the `CHAT_MODEL` constant in `supabase/functions/chat/index.ts`.

---

## Features

- **Streaming responses** — SSE delivers tokens as they generate (~700ms to first token)
- **Source attribution** — response shows which documents were used as context
- **Anti-hallucination prompt** — if the answer isn't in documents, the bot says so
- **Query embedding cache** — identical queries skip the OpenAI embed call (5-min TTL)
- **Rate limiting** — 20 requests/minute per IP in the Edge Function
- **Idempotent ingestion** — re-running on the same file is a no-op (SHA-256 dedup)
- **Chunk dedup** — only new/changed chunks generate embedding API calls
- **Collapsible sidebar** — lists all ingested documents with chunk counts
- **Auto dark/light mode** — follows system preference via CSS `prefers-color-scheme`
- **Mobile responsive** — sidebar overlays on small screens

---

## Scalability Notes

| Concern | Solution |
|---------|----------|
| Large document corpus (>1M rows) | Increase IVFFlat `lists` from 100 → 1000 in migration |
| High query volume | Add Upstash Redis for cross-instance embedding cache |
| Slow search recall | Increase `ivfflat.probes` (set in `match_chunks` function) |
| Long documents | Reduce `CHUNK_SIZE` in `backend/src/chunker.js` |
| Multi-tenant (per-user docs) | Add `user_id` column + RLS policies to both tables |

---

## Environment Variables Reference

### `backend/.env`
| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI key for `text-embedding-3-small` |
| `SUPABASE_URL` | Project URL from Supabase dashboard |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key — bypasses RLS, keep secret |

### `frontend/.env.local`
| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Project URL (same as above) |
| `VITE_SUPABASE_ANON_KEY` | Anon/public key — safe to expose in browser |

### Edge Function secrets (`supabase secrets set`)
| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI key for query embedding |
| `OPENROUTER_API_KEY` | OpenRouter key for chat completions |
