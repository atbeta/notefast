import { createHash } from 'node:crypto'
import type { SemanticHit } from '@notefast/core'
import { getDb } from '../db'
import { getBlockById } from '../store/blocks'

export const VECTOR_INDEX_VERSION = 2

export interface VectorRecord {
  blockId: string
  vector: Float64Array
  modelFingerprint: string
  /** 索引文本（buildIndexedText 输出）的 hash —— freshness 判定用 */
  contentHash: string
  /** block.content 原文的 hash —— 并发写保护用（upsertToGeneration 自校验） */
  sourceContentHash: string
}

export interface VectorSearchOptions {
  limit: number
  modelFingerprint: string
  notebookId?: string
  since?: string
  until?: string
}

export interface VectorStoreStatus {
  backend: string
  status: 'ready' | 'stale' | 'rebuilding' | 'failed'
  modelFingerprint: string | null
  dimension: number | null
  count: number
  activeGeneration: string | null
  stagingGeneration: string | null
  error: string | null
  /** 重建进度（仅 status=rebuilding 时有值） */
  rebuild?: {
    processed: number
    total: number
    started_at: string
    elapsed_ms: number
    eta_ms: number | null
  }
}

export interface VectorStore {
  readonly backend: string
  init(): Promise<void>
  upsert(record: VectorRecord): Promise<void>
  delete(blockId: string): Promise<void>
  /** 批量删除（块删除级联 / ai_exclude purge 用）：计数维护一次完成，
   *  替代逐块 delete 的「每块一次 count(*)」O(n²) 退化 */
  deleteMany(blockIds: string[]): Promise<void>
  search(query: Float64Array, options: VectorSearchOptions): Promise<SemanticHit[]>
  /** 读出某块已入库的向量（无 embed 往返）；没有则 null */
  getStoredVector(blockId: string): Promise<Float64Array | null>
  scoreCandidates(
    query: Float64Array,
    blockIds: string[],
    modelFingerprint: string,
  ): Promise<Map<string, number>>
  count(): Promise<number>
  status(): Promise<VectorStoreStatus>
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function embeddingFingerprint(provider: {
  baseUrl: string
  embeddingModel: string
  apiKey?: string
}): string {
  const baseUrl = provider.baseUrl.trim().replace(/\/+$/, '')
  const model = provider.embeddingModel.trim()
  return createHash('sha256').update(`${baseUrl}\n${model}`).digest('hex')
}

function cosine(a: Float64Array | number[], b: Float64Array | number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!
    const bv = b[i]!
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dot / denominator
}

/** 编码为 little-endian float32 BLOB（体积约为 JSON 文本的 1/5） */
function encodeEmbedding(vector: Float64Array): Uint8Array {
  const f32 = Float32Array.from(vector)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

/** 解码：新格式 BLOB（float32）或旧格式 JSON 文本（迁移前存量） */
export function decodeEmbedding(raw: string | Uint8Array): Float64Array {
  if (typeof raw !== 'string') {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
    if (bytes.byteLength % 4 === 0) {
      // bun:sqlite 返回的 BLOB 可能是大共享 buffer 的视图，先复制到独立 buffer 再构造
      const f32 = new Float32Array(bytes.byteLength / 4)
      new Uint8Array(f32.buffer).set(bytes)
      return Float64Array.from(f32)
    }
    return new Float64Array(0)
  }
  try {
    return Float64Array.from(JSON.parse(raw) as number[])
  } catch {
    return new Float64Array(0)
  }
}

interface StateRow {
  active_backend: string
  status: VectorStoreStatus['status']
  model_fingerprint: string | null
  dimension: number | null
  active_generation: string | null
  staging_generation: string | null
  indexed_count: number
  error: string | null
}

export class JsonVectorStore implements VectorStore {
  readonly backend = 'json'

  async init(): Promise<void> {
    // Schema 由 initDb 统一管理。
  }

  async upsert(record: VectorRecord): Promise<void> {
    const db = getDb()
    const state = this.readState()
    if (
      state.model_fingerprint
      && (state.model_fingerprint !== record.modelFingerprint || state.dimension !== record.vector.length)
      && state.indexed_count > 0
    ) {
      db.query(
        `UPDATE vector_store_state
         SET status = 'stale', error = ?, updated_at = datetime('now')
         WHERE id = 'default'`,
      ).run('Embedding 模型或维度已变化，需要重建向量索引')
      throw new Error('向量索引与当前 embedding 模型不兼容，请先重建索引')
    }

    const embedding = encodeEmbedding(record.vector)
    db.transaction(() => {
      const existed = db.query('SELECT 1 FROM block_vectors WHERE block_id = ?').get(record.blockId)
      db.query(
        `INSERT INTO block_vectors
           (block_id, embedding, dim, embedding_model, content_hash, source_content_hash, index_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(block_id) DO UPDATE SET
           embedding = excluded.embedding,
           dim = excluded.dim,
           embedding_model = excluded.embedding_model,
           content_hash = excluded.content_hash,
           source_content_hash = excluded.source_content_hash,
           index_version = excluded.index_version,
           updated_at = datetime('now')`,
      ).run(
        record.blockId,
        embedding,
        record.vector.length,
        record.modelFingerprint,
        record.contentHash,
        record.sourceContentHash,
        VECTOR_INDEX_VERSION,
      )
      db.query(
        `UPDATE vector_store_state
         SET active_backend = 'json', status = 'ready', model_fingerprint = ?,
             dimension = ?, indexed_count = indexed_count + ?, error = NULL, updated_at = datetime('now')
         WHERE id = 'default'`,
      ).run(record.modelFingerprint, record.vector.length, existed ? 0 : 1)
    })()
  }

  async delete(blockId: string): Promise<void> {
    const db = getDb()
    db.query('DELETE FROM block_vectors WHERE block_id = ?').run(blockId)
    db.query(
      `UPDATE vector_store_state
       SET indexed_count = (SELECT count(*) FROM block_vectors), updated_at = datetime('now')
       WHERE id = 'default'`,
    ).run()
  }

  async deleteMany(blockIds: string[]): Promise<void> {
    if (blockIds.length === 0) return
    const db = getDb()
    const ph = blockIds.map(() => '?').join(',')
    db.query(`DELETE FROM block_vectors WHERE block_id IN (${ph})`).run(...(blockIds as [string, ...string[]]))
    db.query(
      `UPDATE vector_store_state
       SET indexed_count = (SELECT count(*) FROM block_vectors), updated_at = datetime('now')
       WHERE id = 'default'`,
    ).run()
  }

  async getStoredVector(blockId: string): Promise<Float64Array | null> {
    const row = getDb()
      .query(
        `SELECT embedding FROM block_vectors WHERE block_id = ? AND index_version = ?`,
      )
      .get(blockId, VECTOR_INDEX_VERSION) as { embedding: string | Uint8Array } | undefined
    if (!row) return null
    const vector = decodeEmbedding(row.embedding)
    return vector.length > 0 ? vector : null
  }

  async search(query: Float64Array, options: VectorSearchOptions): Promise<SemanticHit[]> {
    const state = this.readState()
    if (
      !['ready', 'rebuilding', 'failed'].includes(state.status)
      || state.model_fingerprint !== options.modelFingerprint
      || state.dimension !== query.length
    ) {
      return []
    }

    const db = getDb()
    let sql = `
      SELECT v.block_id, v.embedding, b.root_id
      FROM block_vectors v
      JOIN blocks b ON b.id = v.block_id
      WHERE v.embedding_model = ? AND v.dim = ? AND v.index_version = ?
        AND b.is_deleted = 0`
    const params: Array<string | number> = [
      options.modelFingerprint,
      query.length,
      VECTOR_INDEX_VERSION,
    ]
    if (options.notebookId) {
      sql += ' AND b.notebook_id = ?'
      params.push(options.notebookId)
    }
    if (options.since) {
      sql += ' AND b.updated_at >= ?'
      params.push(options.since)
    }
    if (options.until) {
      sql += ' AND b.updated_at <= ?'
      params.push(options.until)
    }

    const rows = db.query(sql).all(...params as [string, ...Array<string | number>]) as Array<{
      block_id: string
      embedding: string | Uint8Array
      root_id: string
    }>
    const scored = rows
      .map((row) => {
        const vector = decodeEmbedding(row.embedding)
        return { block_id: row.block_id, root_id: row.root_id, score: vector.length > 0 ? cosine(vector, query) : 0 }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit)

    const contentMap = new Map<string, string>()
    if (scored.length > 0) {
      const ids = scored.map((row) => row.block_id)
      const ph = ids.map(() => '?').join(',')
      const contents = db.query(
        `SELECT id, content FROM blocks WHERE id IN (${ph})`,
      ).all(...(ids as [string, ...string[]])) as Array<{ id: string; content: string }>
      for (const row of contents) contentMap.set(row.id, row.content)
    }

    const titleMap = new Map<string, string>()
    for (const docId of new Set(scored.map((row) => row.root_id))) {
      const doc = getBlockById(db, docId)
      if (doc) titleMap.set(docId, doc.content)
    }
    return scored.map((row) => ({
      block_id: row.block_id,
      score: Math.round(row.score * 10000) / 10000,
      content: contentMap.get(row.block_id) || '',
      doc_id: row.root_id,
      doc_title: titleMap.get(row.root_id) || '未命名文档',
    }))
  }

  async scoreCandidates(
    query: Float64Array,
    blockIds: string[],
    modelFingerprint: string,
  ): Promise<Map<string, number>> {
    const scores = new Map<string, number>()
    if (blockIds.length === 0) return scores
    const state = this.readState()
    if (
      !['ready', 'rebuilding', 'failed'].includes(state.status)
      || state.model_fingerprint !== modelFingerprint
      || state.dimension !== query.length
    ) return scores

    const placeholders = blockIds.map(() => '?').join(', ')
    const rows = getDb().query(
      `SELECT block_id, embedding FROM block_vectors
       WHERE embedding_model = ? AND dim = ? AND index_version = ?
         AND block_id IN (${placeholders})`,
    ).all(
      modelFingerprint,
      query.length,
      VECTOR_INDEX_VERSION,
      ...blockIds,
    ) as Array<{ block_id: string; embedding: string | Uint8Array }>
    for (const row of rows) {
      const vector = decodeEmbedding(row.embedding)
      if (vector.length > 0) scores.set(row.block_id, cosine(vector, query))
    }
    return scores
  }

  async count(): Promise<number> {
    return this.countSync()
  }

  async status(): Promise<VectorStoreStatus> {
    const state = this.readState()
    return {
      backend: state.active_backend,
      status: state.status,
      modelFingerprint: state.model_fingerprint,
      dimension: state.dimension,
      count: state.indexed_count,
      activeGeneration: state.active_generation,
      stagingGeneration: state.staging_generation,
      error: state.error,
    }
  }

  private countSync(modelFingerprint?: string, dimension?: number): number {
    const row = modelFingerprint && dimension
      ? getDb().query(
        'SELECT count(*) AS count FROM block_vectors WHERE embedding_model = ? AND dim = ? AND index_version = ?',
      ).get(modelFingerprint, dimension, VECTOR_INDEX_VERSION)
      : getDb().query('SELECT count(*) AS count FROM block_vectors').get()
    return (row as { count: number } | null)?.count ?? 0
  }

  private readState(): StateRow {
    return getDb().query(
      `SELECT active_backend, status, model_fingerprint, dimension,
              active_generation, staging_generation, indexed_count, error
       FROM vector_store_state WHERE id = 'default'`,
    ).get() as StateRow
  }
}

let activeStore: VectorStore = new JsonVectorStore()

export function getVectorStore(): VectorStore {
  return activeStore
}

export function setVectorStore(store: VectorStore): void {
  activeStore = store
}

export function markVectorStoreStaleIfModelChanged(modelFingerprint: string | null): void {
  if (!modelFingerprint) return
  const db = getDb()
  const row = db.query(
    "SELECT model_fingerprint FROM vector_store_state WHERE id = 'default'",
  ).get() as { model_fingerprint: string | null } | null
  if (row?.model_fingerprint && row.model_fingerprint !== modelFingerprint) {
    db.query(
      `UPDATE vector_store_state
       SET status = 'stale', error = 'Embedding 模型已变化，需要重建向量索引',
           updated_at = datetime('now')
       WHERE id = 'default'`,
    ).run()
  }
}
