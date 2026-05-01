import mammoth from 'mammoth'

/**
 * Extract plain text from a DOCX file.
 * Returns { text: string, pageCount: null } — DOCX format has no reliable page count.
 * Logs mammoth warnings to stderr but does not throw on them.
 */
export async function parseWord(filePath) {
  const result = await mammoth.extractRawText({ path: filePath })
  if (result.messages.length > 0) {
    result.messages.forEach(m => console.warn('[mammoth]', m.message))
  }
  return {
    text: result.value,
    pageCount: null
  }
}
