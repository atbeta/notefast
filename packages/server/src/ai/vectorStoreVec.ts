import { createHash } from 'node:crypto'
import type { SemanticHit } from '@notefast/core'
import { getDb } from '../db'
import { getBlockById } from '../store/blocks'
import { loadSqliteVec } from '../sqliteVec'
import {
  contentHash,
  type VectorRecord,
  type VectorSearchOptions,
  type VectorStore,
  type VectorStoreStatus,
} from './vectorStore'

interface GenerationRow {
  id: string
  table_name: string
  model_fingerprint: string
  dimension: number
  indexed_count: number
}

function tableNameFor(generation: string): string {
  return `vec_blocks_${createHash('sha256').update(generation).digest('hex').slice(0, 16)}`
}

function generationRow(generation: string): GenerationRow | null {
  return getDb().query(
    `SELECT id, table_name, model_fingerprint, dimension, indexed_count
     FROM vector_generations WHERE id = ?`,
  ).get(generation) as GenerationRow | null
}

function activeGeneration(): GenerationRow | null {
  return getDb().query(
    `SELECT g.id, g.table_name, g.model_fingerprint, g.dimension, g.indexed_count
     FROM vector_store_state s
     JOIN vector_generations g ON g.id = s.active_generation
     WHERE s.id = 'default' AND s.active_backend = 'sqlite-vec'`,
  ).get() as GenerationRow | null
}

export class SqliteVecVectorStore implements VectorStore {
  readonly backend = 'sqlite-vec'

  async init(): Promise<void> {
    const db = getDb()
    try {
      db.query('SELECT vec_version()').get()
    } catch {
      loadSqliteVec(db)
    }
  }

  async createGeneration(
    generation: string,
    modelFingerprint: string,
    dimension: number,
  ): Promise<void> {
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error(`非法向量维度: ${dimension}`)
    }
    const db = getDb()
    const existing = generationRow(generation)
    if (existing) {
      if (
        existing.model_fingerprint !== modelFingerprint
        || existing.dimension !== dimension
      ) throw new Error(`generation ${generation} 的模型或维度不一致`)
      return
    }

    const tableName = tableNameFor(generation)
    const generationLiteral = generation.replaceAll("'", "''")
    db.transaction(() => {
      db.query(
        `INSERT INTO vector_generations
           (id, table_name, model_fingerprint, dimension, status)
         VALUES (?, ?, ?, ?, 'staging')`,
      ).run(generation, tableName, modelFingerprint, dimension)
      db.exec(
        `CREATE VIRTUAL TABLE ${tableName} USING vec0(
           embedding float[${dimension}] distance_metric=cosine,
           notebook_id text,
           updated_at text
         )`,
      )
      db.exec(
        `CREATE TRIGGER ${tableName}_block_delete
         BEFORE DELETE ON blocks
         BEGIN
           DELETE FROM ${tableName}
           WHERE rowid IN (
             SELECT id FROM vector_entries
             WHERE generation = '${generationLiteral}' AND block_id = OLD.id
           );
         END`,
      )
    })()
  }

  async upsert(record: VectorRecord): Promise<void> {
    const generation = activeGeneration()
    if (!generation) throw new Error('sqlite-vec 没有 active generation')
    const inserted = await this.upsertToGeneration(generation.id, record)
    if (!inserted) throw new Error(`block ${record.blockId} 内容已变化，拒绝写入过期向量`)
  }

  async upsertToGeneration(generation: string, record: VectorRecord): Promise<boolean> {
    const db = getDb()
    const target = generationRow(generation)
    if (!target) throw new Error(`向量 generation 不存在: ${generation}`)
    if (
      target.model_fingerprint !== record.modelFingerprint
      || target.dimension !== record.vector.length
    ) throw new Error('向量模型或维度与 generation 不匹配')

    const block = getBlockById(db, record.blockId)
    if (!block || contentHash(block.content) !== record.contentHash) return false

    db.transaction(() => {
      let entry = db.query(
        'SELECT id FROM vector_entries WHERE generation = ? AND block_id = ?',
      ).get(generation, record.blockId) as { id: number } | null
      if (!entry) {
        const result = db.query(
          `INSERT INTO vector_entries
             (generation, block_id, content_hash, notebook_id, root_id, block_updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          generation,
          record.blockId,
          record.contentHash,
          block.notebook_id,
          block.root_id,
          block.updated_at,
        )
        entry = { id: Number(result.lastInsertRowid) }
      } else {
        db.query(
          `UPDATE vector_entries
           SET content_hash = ?, notebook_id = ?, root_id = ?, block_updated_at = ?
           WHERE id = ?`,
        ).run(
          record.contentHash,
          block.notebook_id,
          block.root_id,
          block.updated_at,
          entry.id,
        )
        db.query(`DELETE FROM ${target.table_name} WHERE rowid = ?`).run(entry.id)
      }
      db.query(
        `INSERT INTO ${target.table_name}(rowid, embedding, notebook_id, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run(
        entry.id,
        new Float32Array(record.vector),
        block.notebook_id,
        block.updated_at,
      )
      db.query(
        `UPDATE vector_generations
         SET indexed_count = (
           SELECT count(*) FROM vector_entries WHERE generation = ?
         ), updated_at = datetime('now')
         WHERE id = ?`,
      ).run(generation, generation)
    })()
    return true
  }

  async delete(blockId: string): Promise<void> {
    const generation = activeGeneration()
    if (!generation) return
    this.deleteFromGeneration(generation.id, blockId)
  }

  deleteFromGeneration(generation: string, blockId: string): void {
    const db = getDb()
    const target = generationRow(generation)
    if (!target) return
    const entry = db.query(
      'SELECT id FROM vector_entries WHERE generation = ? AND block_id = ?',
    ).get(generation, blockId) as { id: number } | null
    if (!entry) return
    db.transaction(() => {
      db.query(`DELETE FROM ${target.table_name} WHERE rowid = ?`).run(entry.id)
      db.query('DELETE FROM vector_entries WHERE id = ?').run(entry.id)
      db.query(
        `UPDATE vector_generations SET indexed_count = (
           SELECT count(*) FROM vector_entries WHERE generation = ?
         ) WHERE id = ?`,
      ).run(generation, generation)
    })()
  }

  async search(query: Float64Array, options: VectorSearchOptions): Promise<SemanticHit[]> {
    const target = activeGeneration()
    if (
      !target
      || target.model_fingerprint !== options.modelFingerprint
      || target.dimension !== query.length
    ) return []

    let sql = `
      SELECT e.block_id, v.distance, b.content, b.root_id, d.content AS doc_title
      FROM ${target.table_name} v
      JOIN vector_entries e ON e.id = v.rowid AND e.generation = ?
      JOIN blocks b ON b.id = e.block_id
      LEFT JOIN blocks d ON d.id = b.root_id
      WHERE v.embedding MATCH ? AND v.k = ?`
    const params: Array<string | number | Float32Array> = [
      target.id,
      new Float32Array(query),
      options.limit,
    ]
    if (options.notebookId) {
      sql += ' AND v.notebook_id = ?'
      params.push(options.notebookId)
    }
    if (options.since) {
      sql += ' AND v.updated_at >= ?'
      params.push(options.since)
    }
    if (options.until) {
      sql += ' AND v.updated_at <= ?'
      params.push(options.until)
    }
    sql += ' ORDER BY v.distance'

    const rows = getDb().query(sql).all(
      ...params as [string, Float32Array, number, ...Array<string | number>]
    ) as Array<{
      block_id: string
      distance: number
      content: string
      root_id: string
      doc_title: string | null
    }>
    return rows.map((row) => ({
      block_id: row.block_id,
      score: Math.round((1 - row.distance) * 10000) / 10000,
      content: row.content,
      doc_id: row.root_id,
      doc_title: row.doc_title || '未命名文档',
    }))
  }

  async scoreCandidates(
    query: Float64Array,
    blockIds: string[],
    modelFingerprint: string,
  ): Promise<Map<string, number>> {
    const scores = new Map<string, number>()
    const target = activeGeneration()
    if (
      !target
      || target.model_fingerprint !== modelFingerprint
      || target.dimension !== query.length
      || blockIds.length === 0
    ) return scores
    const placeholders = blockIds.map(() => '?').join(', ')
    const rows = getDb().query(
      `SELECT e.block_id, vec_distance_cosine(v.embedding, ?) AS distance
       FROM ${target.table_name} v
       JOIN vector_entries e ON e.id = v.rowid AND e.generation = ?
       WHERE e.block_id IN (${placeholders})`,
    ).all(
      new Float32Array(query),
      target.id,
      ...blockIds,
    ) as Array<{ block_id: string; distance: number }>
    for (const row of rows) scores.set(row.block_id, 1 - row.distance)
    return scores
  }

  async count(): Promise<number> {
    return activeGeneration()?.indexed_count ?? 0
  }

  async activateGeneration(generation: string): Promise<void> {
    const db = getDb()
    const target = generationRow(generation)
    if (!target) throw new Error(`向量 generation 不存在: ${generation}`)
    db.transaction(() => {
      db.query("UPDATE vector_generations SET status = 'retired' WHERE status = 'active'").run()
      db.query(
        "UPDATE vector_generations SET status = 'active', updated_at = datetime('now') WHERE id = ?",
      ).run(generation)
      db.query(
        `UPDATE vector_store_state
         SET active_backend = 'sqlite-vec', status = 'ready',
             model_fingerprint = ?, dimension = ?, active_generation = ?,
             staging_generation = NULL, indexed_count = ?, error = NULL,
             updated_at = datetime('now')
         WHERE id = 'default'`,
      ).run(
        target.model_fingerprint,
        target.dimension,
        generation,
        target.indexed_count,
      )
    })()
  }

  async status(): Promise<VectorStoreStatus> {
    const row = getDb().query(
      `SELECT active_backend, status, model_fingerprint, dimension,
              active_generation, staging_generation, indexed_count, error
       FROM vector_store_state WHERE id = 'default'`,
    ).get() as {
      active_backend: string
      status: VectorStoreStatus['status']
      model_fingerprint: string | null
      dimension: number | null
      active_generation: string | null
      staging_generation: string | null
      indexed_count: number
      error: string | null
    }
    return {
      backend: row.active_backend,
      status: row.status,
      modelFingerprint: row.model_fingerprint,
      dimension: row.dimension,
      count: row.indexed_count,
      activeGeneration: row.active_generation,
      stagingGeneration: row.staging_generation,
      error: row.error,
    }
  }
}
