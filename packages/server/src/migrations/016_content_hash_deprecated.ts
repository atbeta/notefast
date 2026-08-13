import type { Database } from 'bun:sqlite'

/**
 * 016：停用 blocks.content_hash 列（保留列本身，零表重建成本）。
 * 该列历史上「只写不读」——vector/修订的快照 hash 均存各自表，blocks 表
 * 的 hash 无任何读取方；同步 consume 的 upsert 也从没写过它（新行一直是
 * NULL）。本迁移删除其唯一索引，写入路径随之停止维护（见 store/blocks）。
 * 列保留：外部工具/未来「服务端内容指纹」场景可零迁移复用。
 */
export const id = '016_content_hash_deprecated'
export const description = '停用 blocks.content_hash：删索引（列保留，写入停止）'

export function up(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_blocks_content_hash`)
}

export function down(db: Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_content_hash ON blocks(content_hash)`)
}
