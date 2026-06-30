/**
 * 向量索引服务
 *
 * 把 AiRuntime 的 embedding provider 接入到 SQLite block_vectors 表。
 * Plugin hook 由 services/aiRuntime.ts 负责挂载和卸载。
 */

import type { BlockRow } from '@notefast/core'
import { getDb } from '../db'
import { getRuntime } from '../services/aiRuntime'

export async function indexBlock(blockId: string): Promise<void> {
  const r = getRuntime()
  if (!r.hasEmbedding()) return

  const db = getDb()
  const row = db.query('SELECT * FROM blocks WHERE id = ?').get(blockId) as BlockRow | undefined
  if (!row) return

  const text = (row.content || '').trim()
  if (!text) {
    deleteVector(blockId)
    return
  }

  try {
    const vectors = await r.embedBatch([text])
    if (vectors.length > 0 && vectors[0]) {
      upsertVector(blockId, vectors[0])
    }
  } catch (e) {
    console.error(`[ai-indexer] Failed to index ${blockId}:`, e instanceof Error ? e.message : e)
  }
}

export async function indexAllBlocks(notebookId?: string): Promise<{ indexed: number; errors: number }> {
  const r = getRuntime()
  if (!r.hasEmbedding()) {
    throw new Error('Embedding provider is not configured')
  }

  const db = getDb()
  let sql = 'SELECT id, content FROM blocks WHERE content IS NOT NULL AND content != ?'
  const params: string[] = ['']
  if (notebookId) {
    sql += ' AND notebook_id = ?'
    params.push(notebookId)
  }

  const rows = db.query(sql).all(...params) as Array<{ id: string; content: string }>
  if (rows.length === 0) return { indexed: 0, errors: 0 }

  let indexed = 0
  let errors = 0
  // 按 batchSize 分批（runtime 不暴露 batchSize，直接 20 一批）
  const BATCH = 20
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).filter((r2) => r2.content.trim().length > 0)
    if (batch.length === 0) continue
    try {
      const vectors = await r.embedBatch(batch.map((b) => b.content))
      for (let j = 0; j < batch.length && j < vectors.length; j++) {
        if (vectors[j]) upsertVector(batch[j].id, vectors[j])
        indexed++
      }
    } catch (e) {
      console.error('[ai-indexer] Batch error:', e instanceof Error ? e.message : e)
      errors += batch.length
    }
  }

  return { indexed, errors }
}

// ───────────────────── 向量存储底层 ─────────────────────

export function initVectorStore(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS block_vectors (
      block_id  TEXT PRIMARY KEY,
      embedding TEXT NOT NULL,
      dim       INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_block_vectors_dim ON block_vectors(dim);
  `)
}

export function upsertVector(blockId: string, vector: Float64Array): void {
  const db = getDb()
  const arr = Array.from(vector)
  const json = JSON.stringify(arr)
  db.query(
    `INSERT INTO block_vectors (block_id, embedding, dim) VALUES (?, ?, ?)
     ON CONFLICT(block_id) DO UPDATE SET embedding = ?, dim = ?, created_at = datetime('now')`,
  ).run(blockId, json, vector.length, json, vector.length)
}

export function getVector(blockId: string): Float64Array | null {
  const db = getDb()
  const row = db.query('SELECT embedding FROM block_vectors WHERE block_id = ?').get(blockId) as
    | { embedding: string }
    | undefined
  if (!row) return null
  try {
    const arr: number[] = JSON.parse(row.embedding)
    return new Float64Array(arr)
  } catch {
    return null
  }
}

export function deleteVector(blockId: string): void {
  const db = getDb()
  db.query('DELETE FROM block_vectors WHERE block_id = ?').run(blockId)
}

export function getVectorCount(): number {
  const db = getDb()
  const row = db.query('SELECT count(*) as c FROM block_vectors').get() as { c: number }
  return row?.c ?? 0
}

/**
 * 语义搜索（JS 侧 cosine）
 * 行数 <10K 时 O(N) 可接受；超过后建议迁移 sqlite-vec。
 */
export function semanticSearch(
  queryVector: Float64Array,
  limit: number = 10,
  notebookId?: string,
): Array<{ block_id: string; score: number; content: string; doc_id: string; doc_title: string }> {
  const db = getDb()
  let sql = `
    SELECT v.block_id, v.embedding, b.content, b.root_id
    FROM block_vectors v
    JOIN blocks b ON b.id = v.block_id
  `
  const params: string[] = []
  if (notebookId) {
    sql += ' WHERE b.notebook_id = ?'
    params.push(notebookId)
  }
  const rows = db.query(sql).all(...params) as Array<{
    block_id: string
    embedding: string
    content: string
    root_id: string
  }>
  if (rows.length === 0) return []

  // cosineSimilarity 已被 runtime 重导出；这里本地 inline 以免循环依赖
  function cos(a: number[], b: number[]): number {
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i++) {
      const av = a[i]!
      const bv = b[i]!
      dot += av * bv
      na += av * av
      nb += bv * bv
    }
    const d = Math.sqrt(na) * Math.sqrt(nb)
    return d === 0 ? 0 : dot / d
  }

  const scored = rows
    .map((row) => {
      let score = 0
      try {
        const arr: number[] = JSON.parse(row.embedding)
        // 维度不匹配时视为 0（避免无意义比较）
        if (arr.length === queryVector.length) {
          score = cos(arr, Array.from(queryVector))
        }
      } catch {
        /* skip */
      }
      return { ...row, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const docIds = [...new Set(scored.map((r) => r.root_id))]
  const titleMap = new Map<string, string>()
  for (const docId of docIds) {
    const doc = db.query('SELECT content FROM blocks WHERE id = ?').get(docId) as
      | { content: string }
      | undefined
    if (doc) titleMap.set(docId, doc.content)
  }

  return scored.map((r) => ({
    block_id: r.block_id,
    score: Math.round(r.score * 10000) / 10000,
    content: r.content,
    doc_id: r.root_id,
    doc_title: titleMap.get(r.root_id) || '未命名文档',
  }))
}