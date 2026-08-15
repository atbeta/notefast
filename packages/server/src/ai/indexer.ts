/**
 * 向量索引编排
 *
 * 负责 embedding 批处理；存储与检索委托 VectorStore（json / sqlite-vec）。
 * Plugin hook 由 services/aiRuntime.ts 负责挂载和卸载。
 * content_hash 未变时跳过重新 embed；大文档索引走 indexJobs 批处理限流。
 */

import { getDb } from '../db'
import { getBlockById } from '../store/blocks'
import { getRuntime } from '../services/aiRuntime'
import {
  JsonVectorStore,
  contentHash,
  embeddingFingerprint,
  getVectorStore,
  setVectorStore,
  VECTOR_INDEX_VERSION,
} from './vectorStore'
import { SqliteVecVectorStore } from './vectorStoreVec'
import { isBlockAiExcluded, loadAiExcludedDocIds, loadInboxDocIds, loadArchivedDocIds } from './aiExcludeQuery'
import { buildIndexedText } from './indexedText'

export type IndexBlockResult = 'indexed' | 'skipped' | 'deleted' | 'error' | 'noop'

/** 当前指纹下，块是否已有相同 content_hash 的向量（可跳过 embed） */
export function hasFreshVector(blockId: string, content: string): boolean {
  const fingerprint = currentEmbeddingFingerprint()
  if (!fingerprint) return false
  const hash = contentHash(content)
  const db = getDb()
  // json 后端：block_vectors；sqlite-vec：meta 表按 active generation
  const jsonRow = db
    .query(
      `SELECT 1 FROM block_vectors
       WHERE block_id = ? AND embedding_model = ? AND content_hash = ? AND index_version = ?`,
    )
    .get(blockId, fingerprint, hash, VECTOR_INDEX_VERSION)
  if (jsonRow) return true

  const state = db
    .query("SELECT active_backend, active_generation FROM vector_store_state WHERE id = 'default'")
    .get() as { active_backend: string; active_generation: string | null } | undefined
  if (state?.active_backend === 'sqlite-vec' && state.active_generation) {
    const meta = db
      .query(
        `SELECT 1 FROM vector_entries
         WHERE generation = ? AND block_id = ? AND content_hash = ?`,
      )
      .get(state.active_generation, blockId, hash)
    if (meta) return true
  }
  return false
}

export async function indexBlock(blockId: string): Promise<IndexBlockResult> {
  const r = getRuntime()
  if (!r.hasEmbedding()) return 'noop'

  if (isBlockAiExcluded(blockId)) {
    await deleteVector(blockId)
    return 'deleted'
  }

  const db = getDb()
  const row = getBlockById(db, blockId)
  if (!row) return 'noop'

  // 索引文本 = 标题/章节/标签上下文 + 正文 + 图片 caption（与重建同构建器）
  const text = await buildIndexedText(row)
  if (!text) {
    await deleteVector(blockId)
    return 'deleted'
  }

  if (hasFreshVector(blockId, text)) {
    return 'skipped'
  }

  try {
    const vectors = await r.embedBatch([text])
    if (vectors.length > 0 && vectors[0]) {
      await upsertVector(blockId, vectors[0], text)
      return 'indexed'
    }
    return 'error'
  } catch (e) {
    console.error(`[ai-indexer] Failed to index ${blockId}:`, e instanceof Error ? e.message : e)
    return 'error'
  }
}

/** 批量 embed 一批块（供 indexJobs / 全量重建使用）；跳过已新鲜向量 */
export async function indexBlockBatch(
  blockIds: string[],
): Promise<{ indexed: number; skipped: number; errors: number }> {
  const r = getRuntime()
  if (!r.hasEmbedding()) return { indexed: 0, skipped: 0, errors: 0 }

  const db = getDb()
  const toEmbed: Array<{ id: string; content: string }> = []
  let skipped = 0
  let errors = 0

  for (const id of blockIds) {
    if (isBlockAiExcluded(id)) {
      try {
        await deleteVector(id)
      } catch {
        errors++
      }
      continue
    }
    const row = getBlockById(db, id)
    if (!row) continue
    // 与 indexBlock 一致：索引文本含上下文与图片 caption（视觉启用时）
    const text = await buildIndexedText(row)
    if (!text) {
      try {
        await deleteVector(id)
      } catch {
        errors++
      }
      continue
    }
    if (hasFreshVector(id, text)) {
      skipped++
      continue
    }
    toEmbed.push({ id: row.id, content: text })
  }

  if (toEmbed.length === 0) return { indexed: 0, skipped, errors }

  let indexed = 0
  try {
    const vectors = await r.embedBatch(toEmbed.map((b) => b.content))
    for (let j = 0; j < toEmbed.length; j++) {
      const vec = vectors[j]
      if (!vec) {
        errors++
        continue
      }
      try {
        await upsertVector(toEmbed[j]!.id, vec, toEmbed[j]!.content)
        indexed++
      } catch {
        errors++
      }
    }
  } catch (e) {
    console.error('[ai-indexer] Batch error:', e instanceof Error ? e.message : e)
    errors += toEmbed.length
  }

  return { indexed, skipped, errors }
}

export async function indexAllBlocks(notebookId?: string): Promise<{ indexed: number; errors: number }> {
  const r = getRuntime()
  if (!r.hasEmbedding()) {
    throw new Error('Embedding provider is not configured')
  }

  const db = getDb()
  let sql = 'SELECT id, content FROM blocks WHERE content IS NOT NULL AND content != ? AND is_deleted = 0'
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
  const BATCH = 20
  for (let i = 0; i < rows.length; i += BATCH) {
    const batchIds = rows.slice(i, i + BATCH).map((r2) => r2.id)
    const result = await indexBlockBatch(batchIds)
    indexed += result.indexed
    errors += result.errors
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
  const row = getBlockById(getDb(), blockId)
  // content 为索引文本（buildIndexedText 输出）；缺省退化为正文（外部直调场景）
  const indexedText = content ?? row?.content
  if (indexedText === undefined) return
  // 双 hash：content_hash = 索引文本 hash（freshness 判定）；
  // source_content_hash = block.content 原文 hash（并发写保护）
  const sourceContent = row?.content ?? indexedText
  await getVectorStore().upsert({
    blockId,
    vector,
    modelFingerprint: fingerprint,
    contentHash: contentHash(indexedText),
    sourceContentHash: contentHash(sourceContent),
  })
}

export async function deleteVector(blockId: string): Promise<void> {
  await getVectorStore().delete(blockId)
}

/**
 * 批量删除向量（删除整篇文档用）：一次 IN 删除 + 一次 count，避免逐块 delete 的
 * 「每块一次 count(*)」O(n²) 退化（见 VectorStore.deleteMany 注释）。
 */
export async function deleteVectorMany(blockIds: string[]): Promise<void> {
  if (blockIds.length === 0) return
  await getVectorStore().deleteMany(blockIds)
}

/**
 * 语义搜索：委托当前 active VectorStore，过滤 ai_exclude 与 inbox 文档。
 */
export async function semanticSearch(
  queryVector: Float64Array,
  limit: number = 10,
  notebookId?: string,
  since?: string,
  until?: string,
  options?: { includeInbox?: boolean; includeArchived?: boolean },
): Promise<Array<{ block_id: string; score: number; content: string; doc_id: string; doc_title: string }>> {
  const fingerprint = currentEmbeddingFingerprint()
  if (!fingerprint) return []
  // 多取 3 倍，事后过滤后截断
  const raw = await getVectorStore().search(queryVector, {
    limit: limit * 3,
    modelFingerprint: fingerprint,
    notebookId,
    since,
    until,
  })
  if (raw.length === 0) return raw
  const docIds = raw.map((h) => h.doc_id)
  const excluded = loadAiExcludedDocIds(docIds)
  const inbox = options?.includeInbox ? new Set<string>() : loadInboxDocIds(docIds)
  const archived = options?.includeArchived ? new Set<string>() : loadArchivedDocIds(docIds)
  return raw
    .filter((h) => !excluded.has(h.doc_id) && !inbox.has(h.doc_id) && !archived.has(h.doc_id))
    .slice(0, limit)
}
