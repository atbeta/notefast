import { getDb } from '../db'
import { getRuntime } from '../services/aiRuntime'
import { isBlockAiExcluded } from './aiExcludeQuery'
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
import { SqliteVecVectorStore } from './vectorStoreVec'

export interface RebuildEmbeddingProvider {
  fingerprint: string
  embedBatch(texts: string[]): Promise<Float64Array[]>
}

export interface VectorRebuildOptions {
  notebookId?: string
  provider?: RebuildEmbeddingProvider
}

let rebuilding = false

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
  const db = getDb()
  const provider = options.provider ?? runtimeProvider()
  const previousStore = getVectorStore()
  const staging = new SqliteVecVectorStore()
  const generation = crypto.randomUUID()

  try {
    await staging.init()
    let sql = "SELECT id, content FROM blocks WHERE trim(content) != ''"
    const params: string[] = []
    if (options.notebookId) {
      sql += ' AND notebook_id = ?'
      params.push(options.notebookId)
    }
    sql += ' ORDER BY id'
    const rows = (db.query(sql).all(...params) as Array<{ id: string; content: string }>)
      .filter((row) => !isBlockAiExcluded(row.id))
    if (rows.length === 0) throw new Error('没有可建立向量索引的 block')

    const firstBatch = rows.slice(0, 20)
    const firstVectors = await provider.embedBatch(firstBatch.map((row) => row.content))
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
      batch: Array<{ id: string; content: string }>,
      vectors: Float64Array[],
    ) => {
      for (let index = 0; index < batch.length; index++) {
        const vector = vectors[index]
        if (!vector) continue
        await shadow.upsert({
          blockId: batch[index]!.id,
          vector,
          modelFingerprint: provider.fingerprint,
          contentHash: contentHash(batch[index]!.content),
        })
      }
    }
    await writeBatch(firstBatch, firstVectors)
    for (let offset = 20; offset < rows.length; offset += 20) {
      const batch = rows.slice(offset, offset + 20)
      const vectors = await provider.embedBatch(batch.map((row) => row.content))
      await writeBatch(batch, vectors)
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
    throw error
  } finally {
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
