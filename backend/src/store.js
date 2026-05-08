import { createClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'

/**
 * Create a Supabase client using the service role key.
 * persistSession: false is important for server-side / CLI use.
 */
export function createStore(supabaseUrl, serviceRoleKey) {
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false }
  })
  return { supabase }
}

/**
 * Compute SHA-256 hash of a Buffer, returned as hex string.
 */
export function computeFileHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Insert a document row. Returns { id, skipped: true } if the file was already ingested
 * (detected via file_hash UNIQUE constraint), or { id, skipped: false } on new insert.
 */
export async function upsertDocument(supabase, { name, sourceType, fileHash, pageCount, charCount, chunkCount, version, module }) {
  const { data: existing } = await supabase
    .from('documents')
    .select('id')
    .eq('file_hash', fileHash)
    .single()

  if (existing) {
    return { id: existing.id, skipped: true }
  }

  const { data, error } = await supabase
    .from('documents')
    .insert({
      name,
      source_type: sourceType,
      file_hash: fileHash,
      page_count: pageCount,
      char_count: charCount,
      chunk_count: chunkCount,
      version,
      module
    })
    .select('id')
    .single()

  if (error) throw new Error(`Failed to insert document: ${error.message}`)
  return { id: data.id, skipped: false }
}

/**
 * Bulk-upsert document chunks with their embeddings.
 * Embeddings are serialized as pgvector literal strings: "[0.1,0.2,...]".
 * Uses ignoreDuplicates on content_hash to skip unchanged chunks (idempotent re-runs).
 * Batches at 100 rows to stay within Supabase payload limits.
 */
export async function storeChunks(supabase, documentId, chunks, embeddings, onProgress) {
  const rows = chunks.map((chunk, i) => ({
    document_id: documentId,
    chunk_index: i,
    content: chunk.content,
    token_count: chunk.tokenCount,
    embedding: `[${embeddings[i].join(',')}]`, // pgvector literal format
    content_hash: createHash('sha256').update(chunk.content).digest('hex')
  }))

  const STORE_BATCH = 100
  for (let i = 0; i < rows.length; i += STORE_BATCH) {
    const batch = rows.slice(i, i + STORE_BATCH)
    const { error } = await supabase
      .from('document_chunks')
      .upsert(batch, { onConflict: 'document_id,chunk_index', ignoreDuplicates: true })

    if (error) {
      throw new Error(`Failed to store chunks ${i}–${i + STORE_BATCH}: ${error.message}`)
    }
    onProgress?.(Math.min(i + STORE_BATCH, rows.length))
  }
}
