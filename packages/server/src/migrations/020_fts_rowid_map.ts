import type { Database } from 'bun:sqlite'
import { rebuildBlocksFts } from '../fts'

/**
 * 020：FTS 更新/删除改走 rowid 映射。
 *
 * `blocks_fts.id` 是 UNINDEXED，`WHERE id = ?` 必全扫 FTS 倒排。
 * 每次改 content / 硬删除都会扫一遍；批量写入与同步按块放大。
 * 用 blocks_fts_map(block_id → fts_rowid) 把定位变成 PK + FTS rowid 查找。
 */
export const id = '020_fts_rowid_map'
export const description = 'FTS update/delete by mapped rowid (avoid UNINDEXED full scan)'

export function up(db: Database): void {
  rebuildBlocksFts(db)
}
