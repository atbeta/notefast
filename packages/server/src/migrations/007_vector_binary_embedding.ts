import type { Database } from 'bun:sqlite'

/**
 * 007：block_vectors.embedding 改存二进制 float32（原 JSON 文本，体积约 /5）。
 *
 * 旧格式：TEXT 列存 `[0.123, 0.456, ...]`（4096 维 ≈ 88KB/行）
 * 新格式：BLOB 列存 little-endian float32（4096 维 = 16KB/行）
 *
 * 向量语义不变（同一份余弦相似度），无需重建索引；原地转换存量行。
 */
export const id = '007_vector_binary_embedding'
export const description = 'block_vectors.embedding 改存二进制 float32（原 JSON 文本）'
export function up(db: Database): void {
    db.exec('ALTER TABLE block_vectors RENAME TO block_vectors_json')
    db.exec('DROP INDEX IF EXISTS idx_block_vectors_dim')
    db.exec(`
      CREATE TABLE block_vectors (
        block_id  TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        dim       INTEGER NOT NULL,
        embedding_model TEXT,
        content_hash TEXT,
        source_content_hash TEXT,
        index_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS idx_block_vectors_dim ON block_vectors(dim)')

    const rows = db.query(
      `SELECT block_id, embedding, dim, embedding_model, content_hash, source_content_hash,
              index_version, created_at, updated_at
       FROM block_vectors_json`,
    ).all() as Array<{
      block_id: string
      embedding: string | Uint8Array
      dim: number
      embedding_model: string | null
      content_hash: string | null
      source_content_hash: string | null
      index_version: number
      created_at: string
      updated_at: string
    }>

    const insert = db.query(
      `INSERT INTO block_vectors
         (block_id, embedding, dim, embedding_model, content_hash, source_content_hash, index_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const r of rows) {
      let bin: Uint8Array
      if (typeof r.embedding === 'string') {
        const arr = JSON.parse(r.embedding) as number[]
        const f32 = Float32Array.from(arr)
        bin = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
      } else {
        // 已是二进制（理论上前置迁移不存在；防御性处理）
        bin = r.embedding
      }
      insert.run(
        r.block_id, bin, r.dim, r.embedding_model, r.content_hash,
        r.source_content_hash, r.index_version, r.created_at, r.updated_at,
      )
    }

    db.exec('DROP TABLE block_vectors_json')
  }
