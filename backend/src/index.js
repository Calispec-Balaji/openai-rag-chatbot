#!/usr/bin/env node
import 'dotenv/config'
import { program } from 'commander'
import { readFile } from 'fs/promises'
import { extname, basename } from 'path'
import cliProgress from 'cli-progress'

import { parsePdf } from './parsers/pdf.js'
import { parseWord } from './parsers/word.js'
import { chunkMarkdown } from './chunker.js'
import { embedChunks } from './embedder.js'
import { createStore, computeFileHash, upsertDocument, storeChunks } from './store.js'

program
  .name('ingest')
  .description('Ingest PDF/DOCX files into the RAG knowledge base (Supabase + pgvector)')
  .argument('<files...>', 'Paths to PDF or DOCX files to ingest')
  .option('--dry-run', 'Parse and chunk without making any API calls or DB writes')
  .option('--verbose', 'Print chunk contents during processing')
  .parse()

const files = program.args
const opts = program.opts()

// Validate required environment variables before doing any work
const REQUIRED_ENV = ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
const missing = REQUIRED_ENV.filter(k => !process.env[k])
if (missing.length > 0) {
  console.error(`\nMissing required environment variables: ${missing.join(', ')}`)
  console.error('Copy .env.example to .env and fill in the values.\n')
  process.exit(1)
}

const { supabase } = createStore(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const multibar = new cliProgress.MultiBar(
  {
    clearOnComplete: false,
    hideCursor: true,
    format: '  {bar} {percentage}%  {phase}  {value}/{total}'
  },
  cliProgress.Presets.shades_classic
)

let anyError = false

for (const filePath of files) {
  const ext = extname(filePath).toLowerCase()
  const name = basename(filePath)

  console.log(`\n── ${name}`)

  try {
    // ── 1. Parse ───────────────────────────────────────────────────
    let parseResult
    if (ext === '.pdf') {
      parseResult = await parsePdf(filePath)
    } else if (ext === '.docx') {
      parseResult = await parseWord(filePath)
    } else {
      console.error(`  Unsupported type "${ext}". Only .pdf and .docx are supported.`)
      anyError = true
      continue
    }

    const { markdown, pageCount } = parseResult
    console.log(`  Parsed:  ${markdown.length.toLocaleString()} chars, ${pageCount ?? 'N/A'} pages`)

    // ── 2. Chunk ───────────────────────────────────────────────────
    const chunks = chunkMarkdown(markdown)
    console.log(`  Chunks:  ${chunks.length}`)

    if (opts.verbose) {
      chunks.forEach((c, i) =>
        console.log(`  [${i}] ${c.tokenCount} tok: ${c.content.slice(0, 100).replace(/\n/g, ' ')}…`)
      )
    }

    if (opts.dryRun) {
      console.log('  [dry-run] Skipping embedding and storage.')
      continue
    }

    // ── 3. File hash check (skip before any API calls) ─────────────
    const fileBuffer = await readFile(filePath)
    const fileHash = computeFileHash(fileBuffer)

    const { id: docId, skipped } = await upsertDocument(supabase, {
      name,
      sourceType: ext.slice(1), // 'pdf' or 'docx'
      fileHash,
      pageCount,
      charCount: markdown.length,
      chunkCount: chunks.length
    })

    if (skipped) {
      console.log(`  Already ingested (hash match). Use a different file or delete the DB row to re-ingest.`)
      continue
    }

    // ── 4. Embed ───────────────────────────────────────────────────
    const embedBar = multibar.create(chunks.length, 0, { phase: 'Embedding' })
    const embeddings = await embedChunks(
      chunks,
      process.env.OPENAI_API_KEY,
      done => embedBar.update(done)
    )
    embedBar.update(chunks.length)
    embedBar.stop()

    // ── 5. Store ───────────────────────────────────────────────────
    const storeBar = multibar.create(chunks.length, 0, { phase: 'Storing ' })
    await storeChunks(supabase, docId, chunks, embeddings, done => storeBar.update(done))
    storeBar.update(chunks.length)
    storeBar.stop()

    console.log(`  Done: ${chunks.length} chunks stored.`)

  } catch (err) {
    console.error(`  ERROR: ${err.message}`)
    if (opts.verbose) console.error(err.stack)
    anyError = true
  }
}

multibar.stop()
console.log('\nIngestion complete.')
if (anyError) process.exit(1)
