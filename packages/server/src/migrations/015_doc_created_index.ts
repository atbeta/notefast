import type { Database } from 'bun:sqlite'

/**
 * 015：blocks 加 (type, is_deleted, created_at) 索引。
 * getDocNeighbors 从「全表扫描排序」改为按 created_at 范围两次查询取前后一篇，
 * 需要该索引支撑（type/is_deleted 等值过滤 + created_at 范围与排序）。
 * 决胜键保持 rowid（真实入库序）——SQLite 不允许对 rowid 建索引，同毫秒
 * 碰撞组内的 rowid 决胜由查询内微排序完成（组极小），索引管大范围定位。
 */
export const id = '015_doc_created_index'
export const description = '文档邻居导航的范围查询索引 (type, is_deleted, created_at)'

export function up(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_blocks_doc_created
    ON blocks(type, is_deleted, created_at)
  `)
}

export function down(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_blocks_doc_created`)
}
