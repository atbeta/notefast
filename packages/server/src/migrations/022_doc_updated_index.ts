import type { Database } from 'bun:sqlite'

/**
 * 022：邻居翻页改为与文档列表同序（updated_at DESC），
 * 用 (type, is_deleted, updated_at) 替换 015 的 created_at 索引。
 */
export const id = '022_doc_updated_index'
export const description = '文档邻居导航按 updated_at 列表序，替换 created_at 索引'

export function up(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_blocks_doc_created`)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_blocks_doc_updated
    ON blocks(type, is_deleted, updated_at)
  `)
}

export function down(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_blocks_doc_updated`)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_blocks_doc_created
    ON blocks(type, is_deleted, created_at)
  `)
}
