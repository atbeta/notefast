import { getDb } from '../db'
import { getRuntime } from '../services/aiRuntime'
import { isBlockAiExcluded } from './aiExcludeQuery'
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
  const generation = crypto.randomUUID()

  try {
    await staging.init()
    // 构建器需要完整行（parent_id/root_id/type/tags）；软删除块不进索引
    let sql = "SELECT * FROM blocks WHERE trim(content) != '' AND is_deleted = 0"
    const params: string[] = []
    if (options.notebookId) {
      sql += ' AND notebook_id = ?'
      params.push(options.notebookId)
    }
    sql += ' ORDER BY id'
    const rows = (db.query(sql).all(...params) as BlockRow[])
      .filter((row) => !isBlockAiExcluded(row.id))
    if (rows.length === 0) throw new Error('没有可建立向量索引的 block')

    beginRebuildProgress(rows.length)

    // 索引文本与增量路径同一构建器（标题/章节/标签/正文/caption），批内串行构建
    const buildTexts = async (batch: BlockRow[]): Promise<string[]> => {
      const texts: string[] = []
      for (const row of batch) texts.push(await buildIndexedText(row))
      return texts
    }

    const firstBatch = rows.slice(0, REBUILD_BATCH)
    const firstTexts = await buildTexts(firstBatch)
    const firstVectors = await provider.embedBatch(firstTexts)
    const dimension = firstVectors[0]?.length
    if (!dimension) throw new Error('Embedding provider 返回空向量')

    await staging.createGeneration(generation, provider.fingerprint, dimension)
    db.query(
      `UPDATE vector_store_state
       SET status = 'rebuilding', staging_generation = ?, error = NULL,
            updated_at = datetime('now')
       WHERE id = 'default'`,
    ).run(generation)
    const shadow = new ShadowVectorStore(previousStore, staging, generation)
    setVectorStore(shadow)

    const writeBatch = async (
      batch: BlockRow[],
      texts: string[],
      vectors: Float64Array[],
    ) => {
      for (let index = 0; index < batch.length; index++) {
        const vector = vectors[index]
        if (!vector) continue
        await shadow.upsert({
          blockId: batch[index]!.id,
          vector,
          modelFingerprint: provider.fingerprint,
          // 双 hash：content_hash = 索引文本 hash；source_content_hash = 原文 hash
          contentHash: contentHash(texts[index]!),
          sourceContentHash: contentHash(batch[index]!.content),
        })
      }
    }
    await writeBatch(firstBatch, firstTexts, firstVectors)
    bumpRebuildProgress(Math.min(REBUILD_BATCH, rows.length))
    for (let offset = REBUILD_BATCH; offset < rows.length; offset += REBUILD_BATCH) {
      // 取消支持：批间检查，staging 保留（下次重建从 staging 已有块续跑）
      if (cancelRequested) break
      const batch = rows.slice(offset, offset + REBUILD_BATCH)
      const texts = await buildTexts(batch)
      const vectors = await provider.embedBatch(texts)
      await writeBatch(batch, texts, vectors)
      bumpRebuildProgress(Math.min(offset + batch.length, rows.length))
      // 批间让出事件循环 + 防打爆 embedding API（对齐 indexJobs 的 BATCH_GAP_MS）
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
      return (previousStore ?? staging).status()
    }

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
