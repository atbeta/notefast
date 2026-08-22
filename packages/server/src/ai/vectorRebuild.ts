import { getDb } from '../db'
import { getRuntime } from '../services/aiRuntime'
import { buildIndexedText } from './indexedText'
import type { BlockRow } from '@notefast/core'
import {
  contentHash,
  embeddingFingerprint,
  getVectorStore,
  setVectorStore,
  type VectorRecord,
  type VectorSearchOptions,
  type VectorStore,
  type VectorStoreStatus,
} from './vectorStore'
import { SqliteVecVectorStore, dropGeneration } from './vectorStoreVec'
import {
  beginRebuildProgress,
  bumpRebuildProgress,
  endRebuildProgress,
} from './rebuildProgress'

export interface RebuildEmbeddingProvider {
  fingerprint: string
  embedBatch(texts: string[]): Promise<Float64Array[]>
}

/** 重建批大小（对齐增量索引的 20） */
const REBUILD_BATCH = 20
/** 批与批之间最小间隔（对齐 indexJobs 的 BATCH_GAP_MS，避免打爆 embedding API） */
const REBUILD_BATCH_GAP_MS = 50

export interface VectorRebuildOptions {
  notebookId?: string
  provider?: RebuildEmbeddingProvider
}

let rebuilding = false
let cancelRequested = false

/** 请求取消向量重建：下一批开始前生效；staging 保留（下次重建可续） */
export function cancelVectorRebuild(): boolean {
  if (!rebuilding) return false
  cancelRequested = true
  return true
}

class ShadowVectorStore implements VectorStore {
  readonly backend = 'shadow'

  constructor(
    private readonly active: VectorStore,
    private readonly staging: SqliteVecVectorStore,
    private readonly generation: string,
  ) {}

  async init(): Promise<void> {}

  async upsert(record: VectorRecord): Promise<void> {
    try {
      await this.active.upsert(record)
    } catch {
      // 模型切换时旧 active 索引不能接收新模型；staging 仍必须继续。
    }
    await this.staging.upsertToGeneration(this.generation, record)
  }

  async delete(blockId: string): Promise<void> {
    await this.active.delete(blockId)
    this.staging.deleteFromGeneration(this.generation, blockId)
  }

  async deleteMany(blockIds: string[]): Promise<void> {
    await this.active.deleteMany(blockIds)
    this.staging.deleteManyFromGeneration(this.generation, blockIds)
  }

  search(query: Float64Array, options: VectorSearchOptions) {
    return this.active.search(query, options)
  }

  getStoredVector(blockId: string) {
    return this.active.getStoredVector(blockId)
  }

  scoreCandidates(query: Float64Array, blockIds: string[], modelFingerprint: string) {
    return this.active.scoreCandidates(query, blockIds, modelFingerprint)
  }

  count() {
    return this.active.count()
  }

  status() {
    return this.active.status()
  }
}

function runtimeProvider(): RebuildEmbeddingProvider {
  const runtime = getRuntime()
  const definition = runtime.embeddingProviderDef()
  if (!definition || !runtime.hasEmbedding()) {
    throw new Error('Embedding provider is not configured')
  }
  return {
    fingerprint: embeddingFingerprint(definition),
    embedBatch: (texts) => runtime.embedBatch(texts),
  }
}

export async function runVectorRebuild(
  options: VectorRebuildOptions = {},
): Promise<VectorStoreStatus> {
  if (rebuilding) throw new Error('向量索引正在重建')
  rebuilding = true
  cancelRequested = false
  const db = getDb()
  const provider = options.provider ?? runtimeProvider()
  const previousStore = getVectorStore()
  const staging = new SqliteVecVectorStore()
  const stateRow = db.query(
    `SELECT staging_generation, error FROM vector_store_state WHERE id = 'default'`,
  ).get() as { staging_generation: string | null; error: string | null } | null
  const cancelledStaging = stateRow?.error === 'cancelled' ? stateRow.staging_generation : null
  const cancelledRow = cancelledStaging
    ? db.query(
      `SELECT id, model_fingerprint, dimension FROM vector_generations WHERE id = ?`,
    ).get(cancelledStaging) as {
      id: string
      model_fingerprint: string
      dimension: number
    } | null
    : null
  const resume = Boolean(
    cancelledRow && cancelledRow.model_fingerprint === provider.fingerprint,
  )
  const generation = resume ? cancelledRow!.id : crypto.randomUUID()
  if (cancelledStaging && !resume) dropGeneration(cancelledStaging)

  try {
    await staging.init()
    // 构建器需要完整行（parent_id/root_id/type/tags）；软删除块不进索引
    let sql = `SELECT b.* FROM blocks b
      JOIN blocks d ON d.id = b.root_id
      WHERE trim(b.content) != '' AND b.is_deleted = 0
        AND d.is_deleted = 0 AND d.ai_exclude = 0
        AND d.status NOT IN ('inbox', 'archived')`
    const params: string[] = []
    if (options.notebookId) {
      sql += ' AND b.notebook_id = ?'
      params.push(options.notebookId)
    }
    sql += ' ORDER BY b.id'
    const rows = db.query(sql).all(...params) as BlockRow[]
    if (rows.length === 0) throw new Error('没有可建立向量索引的 block')

    beginRebuildProgress(rows.length)

    // 索引文本与增量路径同一构建器（标题/章节/标签/正文/caption），批内串行构建
    const buildTexts = async (batch: BlockRow[]): Promise<string[]> => {
      const texts: string[] = []
      for (const row of batch) texts.push(await buildIndexedText(row))
      return texts
    }

    const existingHashes = resume
      ? new Map(
        (db.query(
          'SELECT block_id, content_hash FROM vector_entries WHERE generation = ?',
        ).all(generation) as Array<{ block_id: string; content_hash: string }>)
          .map((row) => [row.block_id, row.content_hash] as const),
      )
      : new Map<string, string>()

    const writeBatch = async (
      batch: BlockRow[],
      texts: string[],
      vectors: Array<Float64Array | undefined>,
    ) => {
      const shadow = getVectorStore()
      for (let index = 0; index < batch.length; index++) {
        const vector = vectors[index]
        if (!vector) continue
        await shadow!.upsert({
          blockId: batch[index]!.id,
          vector,
          modelFingerprint: provider.fingerprint,
          contentHash: contentHash(texts[index]!),
          sourceContentHash: contentHash(batch[index]!.content),
        })
      }
    }

    const embedFresh = async (batch: BlockRow[]): Promise<{
      texts: string[]
      vectors: Array<Float64Array | undefined>
      embedded: number
    }> => {
      const texts = await buildTexts(batch)
      const needIdx: number[] = []
      for (let i = 0; i < batch.length; i++) {
        if (existingHashes.get(batch[i]!.id) !== contentHash(texts[i]!)) needIdx.push(i)
      }
      const vectors: Array<Float64Array | undefined> = new Array(batch.length)
      if (needIdx.length === 0) return { texts, vectors, embedded: 0 }
      const embeddedVecs = await provider.embedBatch(needIdx.map((i) => texts[i]!))
      for (let j = 0; j < needIdx.length; j++) vectors[needIdx[j]!] = embeddedVecs[j]
      return { texts, vectors, embedded: needIdx.length }
    }

    let dimension = cancelledRow?.dimension
    if (!resume) {
      const firstBatch = rows.slice(0, REBUILD_BATCH)
      const first = await embedFresh(firstBatch)
      dimension = first.vectors.find((v) => v)?.length
      if (!dimension) throw new Error('Embedding provider 返回空向量')
      await staging.createGeneration(generation, provider.fingerprint, dimension)
      db.query(
        `UPDATE vector_store_state
         SET status = 'rebuilding', staging_generation = ?, error = NULL,
              updated_at = datetime('now')
         WHERE id = 'default'`,
      ).run(generation)
      setVectorStore(new ShadowVectorStore(previousStore, staging, generation))
      await writeBatch(firstBatch, first.texts, first.vectors)
      bumpRebuildProgress(Math.min(REBUILD_BATCH, rows.length))
    } else {
      await staging.createGeneration(generation, provider.fingerprint, dimension!)
      db.query(
        `UPDATE vector_store_state
         SET status = 'rebuilding', staging_generation = ?, error = NULL,
              updated_at = datetime('now')
         WHERE id = 'default'`,
      ).run(generation)
      setVectorStore(new ShadowVectorStore(previousStore, staging, generation))
    }

    const startOffset = resume ? 0 : REBUILD_BATCH
    for (let offset = startOffset; offset < rows.length; offset += REBUILD_BATCH) {
      // 取消支持：批间检查，staging 保留（下次重建从已有 content_hash 续跑）
      if (cancelRequested) break
      const batch = rows.slice(offset, offset + REBUILD_BATCH)
      const { texts, vectors } = await embedFresh(batch)
      await writeBatch(batch, texts, vectors)
      bumpRebuildProgress(Math.min(offset + batch.length, rows.length))
      if (offset + REBUILD_BATCH < rows.length && REBUILD_BATCH_GAP_MS > 0) {
        await new Promise((r) => setTimeout(r, REBUILD_BATCH_GAP_MS))
      }
    }

    if (cancelRequested) {
      // 取消：不 activate；staging 保留供续跑。状态标记 stale（旧索引仍可用）
      db.query(
        `UPDATE vector_store_state
         SET status = 'stale', error = 'cancelled', updated_at = datetime('now')
         WHERE id = 'default'`,
      ).run()
      setVectorStore(previousStore)
      return (previousStore ?? staging).status()
    }

    const keepIds = new Set(rows.map((row) => row.id))
    const staleIds = (
      db.query(
        'SELECT block_id FROM vector_entries WHERE generation = ?',
      ).all(generation) as Array<{ block_id: string }>
    )
      .map((row) => row.block_id)
      .filter((id) => !keepIds.has(id))
    if (staleIds.length > 0) staging.deleteManyFromGeneration(generation, staleIds)

    await staging.activateGeneration(generation)
    setVectorStore(staging)
    return staging.status()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const generationExists = db.query(
      'SELECT 1 FROM vector_generations WHERE id = ?',
    ).get(generation)
    if (generationExists) {
      db.query(
        "UPDATE vector_generations SET status = 'failed', error = ? WHERE id = ?",
      ).run(message, generation)
    }
    db.query(
      `UPDATE vector_store_state
       SET status = 'failed', staging_generation = NULL, error = ?,
           updated_at = datetime('now')
       WHERE id = 'default'`,
    ).run(message)
    setVectorStore(previousStore)
    // 失败 staging 的虚拟表/触发器/向量条目彻底清掉（只标 failed 会随备份恢复
    // 传播且占磁盘；dropGeneration 失败（vec0 未加载）时保留行供维护任务重试）
    if (generationExists) dropGeneration(generation)
    throw error
  } finally {
    endRebuildProgress()
    rebuilding = false
  }
}

export function startVectorRebuild(options: VectorRebuildOptions = {}): boolean {
  if (rebuilding) return false
  void runVectorRebuild(options).catch((error) => {
    console.error('[vector-rebuild]', error instanceof Error ? error.message : error)
  })
  return true
}
