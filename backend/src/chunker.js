import { getEncoding } from 'js-tiktoken'

const CHUNK_SIZE = 512    // max tokens per chunk
const CHUNK_OVERLAP = 100 // tokens of overlap between consecutive chunks

/**
 * Split text into overlapping chunks using token-aware sentence-boundary splitting.
 * Uses cl100k_base encoding (same tokenizer as text-embedding-3-small).
 *
 * Returns [{ content: string, tokenCount: number }]
 */
export function chunkText(text) {
  const enc = getEncoding('cl100k_base')

  // Normalize excessive blank lines, then split on sentence boundaries or paragraph breaks.
  // Lookbehind on [.?!] followed by space+capital covers most English sentences.
  const sentences = text
    .replace(/\n{3,}/g, '\n\n')
    .split(/(?<=[.?!])\s+(?=[A-Z])|(?:\n\n+)/)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  const chunks = []
  let currentText = []   // sentence strings in the current chunk
  let currentTokens = [] // corresponding token ids

  for (const sentence of sentences) {
    const sentenceTokens = enc.encode(sentence)

    if (currentTokens.length + sentenceTokens.length > CHUNK_SIZE && currentText.length > 0) {
      // Emit current chunk
      chunks.push({
        content: currentText.join(' '),
        tokenCount: currentTokens.length
      })

      // Build overlap: walk backward through currentText to find sentences
      // that fit within CHUNK_OVERLAP tokens
      let overlapTokenCount = 0
      let overlapStart = currentText.length
      for (let i = currentText.length - 1; i >= 0; i--) {
        const t = enc.encode(currentText[i]).length
        if (overlapTokenCount + t > CHUNK_OVERLAP) break
        overlapTokenCount += t
        overlapStart = i
      }

      currentText = currentText.slice(overlapStart)
      // Re-encode the overlap portion for accurate token count
      currentTokens = enc.encode(currentText.join(' '))
    }

    currentText.push(sentence)
    currentTokens = enc.encode(currentText.join(' '))
  }

  // Emit the final remaining chunk
  if (currentText.length > 0) {
    chunks.push({
      content: currentText.join(' '),
      tokenCount: currentTokens.length
    })
  }

  enc.free() // release WASM memory
  return chunks
}
