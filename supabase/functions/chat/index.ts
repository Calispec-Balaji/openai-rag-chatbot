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

const CHAT_PROVIDER   = Deno.env.get("CHAT_PROVIDER")   ?? "openai"; // "openai" | "openrouter"
const CHAT_MODEL      = Deno.env.get("CHAT_MODEL")      ?? "gpt-4o-mini";
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

const MATCH_THRESHOLD = 0.55;
const MATCH_COUNT = 12;

// Short casual messages that don't need vector search
const CONVERSATIONAL_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|great|cool|sounds good|sounds great|oh|wow|nice|awesome|perfect|got it|i see|alright|sure|yes|no|bye|goodbye|thats good|that's good|that's great|thats great|good|noted)\b\.?$/i;

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

  // Short-circuit conversational messages — no vector search needed
  if (CONVERSATIONAL_RE.test(query.trim())) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const casualResponse = new Response(readable, {
      headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
    });
    (async () => {
      try {
        const res = await fetch(PROVIDER_CONFIG.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${PROVIDER_CONFIG.apiKey}`, "Content-Type": "application/json", ...PROVIDER_CONFIG.extraHeaders },
          body: JSON.stringify({
            model: CHAT_MODEL,
            messages: [
              { role: "system", content: "You are Calispec Assistant, a friendly virtual assistant for the Calispec Gauge Management System. Respond naturally and briefly to the user's casual message. Keep it short and warm." },
              ...history.slice(-4).map((m) => ({ role: m.role, content: m.content })),
              { role: "user", content: query.trim() },
            ],
            stream: true, temperature: 0.7, max_tokens: 100,
          }),
        });
        if (res.ok && res.body) {
          const reader = res.body.getReader();
          while (true) { const { done, value } = await reader.read(); if (done) break; await writer.write(value); }
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (err) { console.error("[chat] casual error:", err); }
      finally { try { await writer.close(); } catch { /* ignore */ } }
    })();
    return casualResponse;
  }

  // For short follow-up queries (≤6 words), combine with last user turn to resolve
  // references like "what about step 3?" or "bulk status?".
  // Full standalone questions are used as-is to avoid context contamination.
  const currentWordCount = query.trim().split(/\s+/).length;
  const lastUserTurn = history.filter((m) => m.role === "user").slice(-1)[0]?.content ?? "";
  const searchQuery =
    currentWordCount <= 6 && lastUserTurn
      ? `${lastUserTurn} ${query.trim()}`
      : query.trim();
  const normalizedQuery = searchQuery.toLowerCase();

  // ── Step 1: Embed the query (cache-first) ────────────────────────────────
  let queryEmbedding = getCachedEmbedding(normalizedQuery);

  if (!queryEmbedding) {
    const embedRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: searchQuery }),
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
    query_text: query.trim(),
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
    ? `You are Calispec Assistant, a virtual assistant for the Calispec Gauge Management System (GMS).

Answer questions using ONLY the document context provided below. Never use general knowledge or invent steps, fields, or features not found in the context.

If the answer is not in the context, say exactly:
"I don't have that information in my knowledge base. Please contact your system administrator or refer to the Calispec documentation."

DOCUMENT CONTEXT:
${contextBlock}

RESPONSE STYLE:
- Friendly, professional, and clear — like a knowledgeable colleague, not a robot quoting a manual
- Give complete answers covering all relevant steps and fields
- Do not mention the document name repeatedly in your response

FORMATTING:
- Use **bold** for field names and important terms
- Use numbered lists for steps, bullet points for options/fields
- NEVER use: # headings, | tables, HTML tags, emojis, or --- dividers
- Keep structure clean and easy to read`
    : `You are Calispec Assistant, a virtual assistant for the Calispec Gauge Management System (GMS).

No relevant documentation was found for this query.

- If the user is greeting you, making small talk, or giving a casual acknowledgment (e.g. "hi", "thanks", "ok", "sounds great", "got it"), respond naturally and briefly in a friendly tone.
- Otherwise, say: "I don't have that information in my knowledge base. Please contact your system administrator."

FORMATTING: No # headings, no | tables, no HTML, no emojis, no --- dividers.`;

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
          temperature: 0.2,
          max_tokens: 2048,
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
