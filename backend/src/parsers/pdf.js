import { readFile } from 'fs/promises'
import pdfParse from 'pdf-parse'

/**
 * Extract plain text from a PDF file.
 * Returns { text: string, pageCount: number }.
 * Throws if the file is encrypted or unreadable.
 */
export async function parsePdf(filePath) {
  const buffer = await readFile(filePath)
  const data = await pdfParse(buffer)
  return {
    text: data.text,
    pageCount: data.numpages
  }
}
