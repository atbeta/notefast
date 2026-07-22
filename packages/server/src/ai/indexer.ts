/**
 * 向量索引编排
 *
 * 负责 embedding 批处理；存储与检索委托 VectorStore（json / sqlite-vec）。
 * Plugin hook 由 services/aiRuntime.ts 负责挂载和卸载。
 */

import type { BlockRow } from '@notefast/core'
import { getDb } from '../db'
import { getRuntime } from '../services/aiRuntime'
import {
  JsonVectorStore,
  contentHash,
  embeddingFingerprint,
  getVectorStore,
  setVectorStore,
} from './vectorStore'
import { SqliteVecVectorStore } from './vectorStoreVec'
import { isBlockAiExcluded, loadAiExcludedDocIds } from './aiExcludeQuery'

export async function indexBlock(blockId: string): Promise<void> {
  const r = getRuntime()
  if (!r.hasEmbedding()) return

  if (isBlockAiExcluded(blockId)) {
    await deleteVector(blockId)
    return
  }

  const db = getDb()
  const row = db.query('SELECT * FROM blocks WHERE id = ?').get(blockId) as BlockRow | undefined
  if (!row) return

  const text = (row.content || '').trim()
  if (!text) {
    await deleteVector(blockId)
    return
  }

  try {
    const vectors = await r.embedBatch([text])
    if (vectors.length > 0 && vectors[0]) {
      await upsertVector(blockId, vectors[0], row.content)
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

  const rows = (db.query(sql).all(...params) as Array<{ id: string; content: string }>)
    .filter((row) => !isBlockAiExcluded(row.id))
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
        if (vectors[j]) await upsertVector(batch[j].id, vectors[j], batch[j].content)
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

export async function initVectorStore(): Promise<void> {
  const db = getDb()
  const state = db.query(
    "SELECT active_backend, status FROM vector_store_state WHERE id = 'default'",
  ).get() as { active_backend: string; status: string }
  if (state.status === 'rebuilding') {
    db.query(
      `UPDATE vector_store_state
       SET status = 'failed', staging_generation = NULL,
           error = '服务在向量重建期间重启，请重新发起重建',
           updated_at = datetime('now')
       WHERE id = 'default'`,
    ).run()
  }
  const store = state.active_backend === 'sqlite-vec'
    ? new SqliteVecVectorStore()
    : new JsonVectorStore()
  await store.init()
  setVectorStore(store)
}

export function currentEmbeddingFingerprint(): string | null {
  const provider = getRuntime().embeddingProviderDef()
  return provider ? embeddingFingerprint(provider) : null
}

export async function upsertVector(
  blockId: string,
  vector: Float64Array,
  content?: string,
): Promise<void> {
  const fingerprint = currentEmbeddingFingerprint()
  if (!fingerprint) throw new Error('Embedding provider is not configured')
  const blockContent = content ?? (
    getDb().query('SELECT content FROM blocks WHERE id = ?').get(blockId) as { content: string } | null
  )?.content
  if (blockContent === undefined) return
  await getVectorStore().upsert({
    blockId,
    vector,
    modelFingerprint: fingerprint,
    contentHash: contentHash(blockContent),
  })
}

export async function deleteVector(blockId: string): Promise<void> {
  await getVectorStore().delete(blockId)
}

/** 语义搜索：委托当前 active VectorStore（json 或 sqlite-vec），并过滤 ai_exclude 文档 */
export async function semanticSearch(
  queryVector: Float64Array,
  limit: number = 10,
  notebookId?: string,
  since?: string,
  until?: string,
): Promise<Array<{ block_id: string; score: number; content: string; doc_id: string; doc_title: string }>> {
  const fingerprint = currentEmbeddingFingerprint()
  if (!fingerprint) return []
  // 多取 3 倍，事后过滤 ai_exclude 文档后截断
  const raw = await getVectorStore().search(queryVector, {
    limit: limit * 3,
    modelFingerprint: fingerprint,
    notebookId,
    since,
    until,
  })
  if (raw.length === 0) return raw
  const excluded = loadAiExcludedDocIds(raw.map((h) => h.doc_id))
  return raw.filter((h) => !excluded.has(h.doc_id)).slice(0, limit)
}