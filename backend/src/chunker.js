import { getEncoding } from 'js-tiktoken'

const CHUNK_SIZE = 512    // max tokens per chunk
const CHUNK_OVERLAP = 100 // overlap tokens when splitting oversized sections

// ── Sentence-level splitter (used for oversized sections) ────────────────────

function splitWithOverlap(text, enc) {
  const sentences = text
    .split(/(?<=[.?!])\s+(?=[A-Z])|(?:\n\n+)/)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  const chunks = []
  let currentText = []
  let currentTokens = []

  for (const sentence of sentences) {
    const sentenceTokens = enc.encode(sentence)

    if (currentTokens.length + sentenceTokens.length > CHUNK_SIZE && currentText.length > 0) {
      chunks.push({ content: currentText.join(' '), tokenCount: currentTokens.length })

      let overlapCount = 0
      let overlapStart = currentText.length
      for (let i = currentText.length - 1; i >= 0; i--) {
        const t = enc.encode(currentText[i]).length
        if (overlapCount + t > CHUNK_OVERLAP) break
        overlapCount += t
        overlapStart = i
      }
      currentText = currentText.slice(overlapStart)
      currentTokens = enc.encode(currentText.join(' '))
    }

    currentText.push(sentence)
    currentTokens = enc.encode(currentText.join(' '))
  }

  if (currentText.length > 0) {
    chunks.push({ content: currentText.join(' '), tokenCount: currentTokens.length })
  }

  return chunks
}

// ── Markdown section splitter ────────────────────────────────────────────────

/**
 * Split a Markdown string into sections at heading boundaries (## and ###).
 * Each section includes its heading line followed by all body text until the next heading.
 */
function splitMarkdownIntoSections(markdown) {
  const lines = markdown.split('\n')
  const sections = []
  let current = []

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line) && current.length > 0) {
      const text = current.join('\n').trim()
      if (text) sections.push(text)
      current = [line]
    } else {
      current.push(line)
    }
  }

  const last = current.join('\n').trim()
  if (last) sections.push(last)

  return sections.filter(s => s.trim().length > 0)
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Chunk a Markdown string into RAG-ready pieces.
 *
 * Each ## / ### heading starts a new chunk boundary so sections are never
 * split across chunks. Sections that exceed CHUNK_SIZE tokens are split
 * internally with CHUNK_OVERLAP token lookback; overlap never crosses a
 * heading boundary.
 *
 * Returns [{ content: string, tokenCount: number }]
 */
export function chunkMarkdown(markdown) {
  const enc = getEncoding('cl100k_base')
  const sections = splitMarkdownIntoSections(markdown)
  const chunks = []

  for (const section of sections) {
    const tokenCount = enc.encode(section).length

    if (tokenCount <= CHUNK_SIZE) {
      chunks.push({ content: section, tokenCount })
    } else {
      chunks.push(...splitWithOverlap(section, enc))
    }
  }

  if (typeof enc.free === 'function') enc.free()
  return chunks
}
