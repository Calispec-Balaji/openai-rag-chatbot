import OpenAI from 'openai'

const BATCH_SIZE = 100  // OpenAI embeddings API max inputs per request
const MODEL = 'text-embedding-3-small'

/**
 * Generate embeddings for an array of chunks via OpenAI.
 * Processes in batches of 100 with exponential-backoff retry on rate limits.
 *
 * @param {Array<{content: string, tokenCount: number}>} chunks
 * @param {string} apiKey
 * @param {(done: number) => void} [onProgress] - called after each batch
 * @returns {Promise<number[][]>} embedding vectors in input order
 */
export async function embedChunks(chunks, apiKey, onProgress) {
  const client = new OpenAI({ apiKey })
  const texts = chunks.map(c => c.content)
  const embeddings = []

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    const response = await embedWithRetry(client, batch)
    // response.data is sorted by index, guaranteed to match input order
    response.data.forEach(item => embeddings.push(item.embedding))
    onProgress?.(Math.min(i + BATCH_SIZE, texts.length))
  }

  return embeddings
}

async function embedWithRetry(client, batch, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await client.embeddings.create({
        model: MODEL,
        input: batch,
        encoding_format: 'float'
      })
    } catch (err) {
      if (err.status === 429 && attempt < retries - 1) {
        const delayMs = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s
        console.warn(`[embedder] Rate limited. Retrying in ${delayMs}ms...`)
        await new Promise(r => setTimeout(r, delayMs))
      } else {
        throw err
      }
    }
  }
}
