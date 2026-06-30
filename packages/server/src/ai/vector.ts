/**
 * 基于 SQLite 的轻量向量存储
 *
 * 不依赖 sqlite-vec 等 native 扩展。
 * 向量以 JSON 字符串存储，查询时在 JS 侧计算余弦相似度。
 * 适用于 <10K 文档的场景；超大规模可后续平滑升级到 pgvector/sqlite-vec。
 */

import { getDb } from '../db'
import type { SemanticHit } from '@notefast/core'
import { cosineSimilarity } from '@notefast/core'

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
  db.query(
    `INSERT INTO block_vectors (block_id, embedding, dim) VALUES (?, ?, ?)
     ON CONFLICT(block_id) DO UPDATE SET embedding = ?, dim = ?, created_at = datetime('now')`,
  ).run(blockId, JSON.stringify(arr), vector.length, JSON.stringify(arr), vector.length)
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

export function semanticSearch(
  queryVector: Float64Array,
  limit: number = 10,
  notebookId?: string,
): SemanticHit[] {
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

  // JS 侧计算相似度
  const scored = rows
    .map((row) => {
      let score = 0
      try {
        const arr: number[] = JSON.parse(row.embedding)
        score = cosineSimilarity(queryVector, arr)
      } catch { /* skip malformed rows */ }
      return { ...row, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  // 批量查标题
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
