import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";

// ── Environment variables ────────────────────────────────────────────────────
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the runtime.
// OPENAI_API_KEY and OPENROUTER_API_KEY must be set via `supabase secrets set`.
// CHAT_PROVIDER, CHAT_MODEL, and EMBEDDING_MODEL are optional secrets with safe defaults.
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CHAT_PROVIDER   = Deno.env.get("CHAT_PROVIDER")   ?? "openrouter"; // "openai" | "openrouter"
const CHAT_MODEL      = Deno.env.get("CHAT_MODEL")      ?? "meta-llama/llama-3.1-8b-instruct:free";
const EMBEDDING_MODEL = Deno.env.get("EMBEDDING_MODEL") ?? "text-embedding-3-small";

const PROVIDER_CONFIG = CHAT_PROVIDER === "openai"
  ? {
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: OPENAI_API_KEY,
      extraHeaders: {} as Record<string, string>,
    }
  : {
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: OPENROUTER_API_KEY,
      extraHeaders: {
        "HTTP-Referer": "https://your-domain.com",
        "X-Title": "RAG Chatbot",
      } as Record<string, string>,
    };

const MATCH_THRESHOLD = 0.7;
const MATCH_COUNT = 5;

// ── CORS headers ─────────────────────────────────────────────────────────────
// Tighten Access-Control-Allow-Origin to your production domain before shipping.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── In-memory query embedding cache ─────────────────────────────────────────
// Keyed by normalised query string. Per-isolate; not shared across instances.
// Saves one OpenAI API call for repeated identical queries within 5 minutes.
const embedCache = new Map<string, { embedding: number[]; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX = 200;

function getCachedEmbedding(key: string): number[] | null {
  const entry = embedCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    embedCache.delete(key);
    return null;
  }
  return entry.embedding;
}

function setCachedEmbedding(key: string, embedding: number[]) {
  if (embedCache.size >= CACHE_MAX) {
    // Evict the oldest entry
    const oldest = [...embedCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    embedCache.delete(oldest[0]);
  }
  embedCache.set(key, { embedding, ts: Date.now() });
}

// ── Per-IP rate limiter (token bucket, 20 req/min) ───────────────────────────
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now - record.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= RATE_LIMIT) return false;
  record.count++;
  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Main handler ─────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Rate limiting
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (!checkRateLimit(clientIp)) {
    return jsonResponse({ error: "Rate limit exceeded. Try again in a minute." }, 429);
  }

  // Parse request body
  let body: { query: string; history?: { role: string; content: string }[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { query, history = [] } = body;
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return jsonResponse({ error: "query is required and must be a non-empty string" }, 400);
  }

  const normalizedQuery = query.trim().toLowerCase();

  // ── Step 1: Embed the query (cache-first) ────────────────────────────────
  let queryEmbedding = getCachedEmbedding(normalizedQuery);

  if (!queryEmbedding) {
    const embedRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: query.trim() }),
    });

    if (!embedRes.ok) {
      const err = await embedRes.text();
      console.error("[chat] OpenAI embed error:", err);
      return jsonResponse({ error: "Failed to generate query embedding" }, 502);
    }

    const embedData = await embedRes.json();
    queryEmbedding = embedData.data[0].embedding as number[];
    setCachedEmbedding(normalizedQuery, queryEmbedding);
  }

  // ── Step 2: Vector search via match_chunks RPC ───────────────────────────
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: chunks, error: rpcError } = await supabase.rpc("match_chunks", {
    query_embedding: queryEmbedding,
    match_threshold: MATCH_THRESHOLD,
    match_count: MATCH_COUNT,
  });

  if (rpcError) {
    console.error("[chat] RPC error:", rpcError);
    return jsonResponse({ error: "Vector search failed" }, 502);
  }

  // ── Step 3: Build RAG prompt ─────────────────────────────────────────────
  type Chunk = { content: string; document_name: string; similarity: number };

  const hasContext = Array.isArray(chunks) && chunks.length > 0;
  let contextBlock = "";
  let sourceNames: string[] = [];

  if (hasContext) {
    contextBlock = (chunks as Chunk[])
      .map(
        (c, i) =>
          `[Source ${i + 1}: ${c.document_name} (relevance: ${c.similarity.toFixed(3)})]\n${c.content}`
      )
      .join("\n\n---\n\n");
    sourceNames = [...new Set((chunks as Chunk[]).map((c) => c.document_name))];
  }

  const systemPrompt = hasContext
    ? `You are a helpful assistant that answers questions exclusively from the provided document context.

DOCUMENT CONTEXT:
${contextBlock}

STRICT RULES:
- Answer ONLY based on the context above. Do not use any prior knowledge or outside information.
- If the answer cannot be found in the context, respond with exactly: "I don't have information about that in the documents."
- Cite the source document name when referencing specific information (e.g., "According to [document name]...").
- Be concise, accurate, and do not fabricate any details.
- Do not speculate or extrapolate beyond what the context explicitly states.`
    : `You are a helpful assistant. The knowledge base returned no documents relevant to this query. Respond with exactly: "I don't have information about that in the documents."`;

  // Include last 3 conversation turns (6 messages) to maintain context without token bloat
  const conversationHistory = history.slice(-6).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    { role: "user", content: query.trim() },
  ];

  // ── Step 4: Stream response via OpenRouter ───────────────────────────────
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const streamResponse = new Response(readable, {
    headers: {
      ...CORS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no", // disable nginx buffering if behind a proxy
    },
  });

  // Fire-and-forget: run the LLM fetch in the background while returning the stream
  (async () => {
    try {
      // Emit sources metadata before the LLM stream begins so the client
      // can display which documents are being referenced immediately
      await writer.write(
        encoder.encode(
          `event: sources\ndata: ${JSON.stringify({ sources: sourceNames })}\n\n`
        )
      );

      const orRes = await fetch(PROVIDER_CONFIG.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PROVIDER_CONFIG.apiKey}`,
          "Content-Type": "application/json",
          ...PROVIDER_CONFIG.extraHeaders,
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          messages,
          stream: true,
          temperature: 0.1,
          max_tokens: 1024,
        }),
      });

      if (!orRes.ok || !orRes.body) {
        const errText = await orRes.text();
        console.error(`[chat] ${CHAT_PROVIDER} error:`, errText);
        await writer.write(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: "LLM request failed" })}\n\n`
          )
        );
        return;
      }

      // Pipe the OpenRouter SSE stream directly to the client
      const reader = orRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }

      // Signal that the stream is complete
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (err) {
      console.error("[chat] Stream error:", err);
      try {
        await writer.write(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`
          )
        );
      } catch {
        // writer already closed — ignore
      }
    } finally {
      try {
        await writer.close();
      } catch {
        // already closed — ignore
      }
    }
  })();

  return streamResponse;
});
