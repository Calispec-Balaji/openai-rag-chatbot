import { readFile } from 'fs/promises'
import pdfParse from 'pdf-parse'

// ── Text item grouping helpers ───────────────────────────────────────────────

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Group raw pdfjs text items into lines.
 * Items sharing the same rounded Y-position (within 2px) belong to the same line.
 * Returns lines sorted top→bottom (descending Y in PDF coordinate space).
 */
function groupIntoLines(items) {
  const lineMap = new Map()
  for (const item of items) {
    if (!item.str.trim()) continue
    const y = Math.round(item.transform[5])
    if (!lineMap.has(y)) lineMap.set(y, [])
    lineMap.get(y).push(item)
  }
  // Sort lines top→bottom (higher Y = higher on page in PDF coords)
  return [...lineMap.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, items]) => ({
      y,
      text: items
        .sort((a, b) => a.transform[4] - b.transform[4]) // left→right by X
        .map(i => i.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      height: Math.max(...items.map(i => i.height || 0))
    }))
    .filter(l => l.text.length > 0)
}

// ── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parse a PDF to Markdown using font-size metadata for heading detection.
 *
 * Strategy:
 * 1. Extract text items per page via pdf-parse pagerender callback.
 * 2. Find repeated Y-positions across pages → page headers/footers → strip them.
 * 3. Compute median body font height → classify lines as ##/### headings or body.
 * 4. Join into Markdown paragraphs respecting vertical gaps.
 *
 * Returns { markdown: string, pageCount: number }
 */
export async function parsePdf(filePath) {
  const buffer = await readFile(filePath)

  // Collect per-page line data during render
  const pages = []

  async function renderPage(pageData) {
    const content = await pageData.getTextContent()
    const lines = groupIntoLines(content.items)
    pages.push(lines)
    // Return empty string — we build our own output below
    return ''
  }

  const data = await pdfParse(buffer, { pagerender: renderPage })
  const pageCount = data.numpages

  // ── 1. Find page header/footer Y-positions ─────────────────────────────
  // A Y-position that appears on more than half the pages is a header/footer.
  const yFrequency = new Map()
  for (const pageLines of pages) {
    const seenYs = new Set(pageLines.map(l => l.y))
    for (const y of seenYs) {
      yFrequency.set(y, (yFrequency.get(y) || 0) + 1)
    }
  }
  const headerFooterYs = new Set(
    [...yFrequency.entries()]
      .filter(([, count]) => count >= pages.length * 0.4)
      .map(([y]) => y)
  )

  // ── 2. Compute median body font height across all pages ────────────────
  const allHeights = pages.flatMap(p =>
    p.filter(l => !headerFooterYs.has(l.y)).map(l => l.height)
  ).filter(h => h > 0)
  const bodyHeight = median(allHeights)

  // ── 3. Build Markdown ─────────────────────────────────────────────────
  const mdLines = []

  for (const pageLines of pages) {
    const filtered = pageLines.filter(l => !headerFooterYs.has(l.y))
    if (filtered.length === 0) continue

    let prevY = null

    for (const line of filtered) {
      // Insert paragraph break on large vertical gap
      if (prevY !== null) {
        const gap = prevY - line.y
        const lineHeight = line.height || bodyHeight
        if (gap > lineHeight * 2) {
          mdLines.push('')
        }
      }

      // Classify by font height relative to body
      const ratio = bodyHeight > 0 ? line.height / bodyHeight : 1
      if (ratio >= 1.5) {
        mdLines.push(`## ${line.text}`)
      } else if (ratio >= 1.2) {
        mdLines.push(`### ${line.text}`)
      } else {
        mdLines.push(line.text)
      }

      prevY = line.y
    }

    // Page boundary = paragraph break
    mdLines.push('')
  }

  // Collapse runs of 3+ blank lines to a single blank line
  const markdown = mdLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { markdown, pageCount }
}
