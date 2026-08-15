import type { Database } from 'bun:sqlite'

/**
 * 018：实体索引状态（entity_index_state）——实体完整性感知。
 *
 * 与 vector_store_state 对等：向量层有 ready/stale/rebuilding/failed 状态机，
 * 实体层此前完全没有状态 —— 用户无法感知「实体从未建过（空）」「已建但只覆盖
 * 一部分块」「重建失败」。本表让设置页能显示实体索引的完整性。
 *
 * 状态语义：
 *  - empty      entities 表为空（从未建 / 全部被清）
 *  - ready      最近一次重建成功完成
 *  - rebuilding 重建进行中
 *  - failed     最近一次重建失败（error 字段记录原因）
 *
 * 覆盖信号：analyzed_blocks = 最近一次重建实际分析过的块数；
 *           用户可对比「库内应分析的块数」判断完整性。
 */
export const id = '018_entity_index_state'
export const description = 'entity index state (completeness awareness for the maintenance/settings UI)'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_index_state (
      id              TEXT PRIMARY KEY CHECK (id = 'default'),
      status          TEXT NOT NULL DEFAULT 'empty',
      analyzed_blocks INTEGER NOT NULL DEFAULT 0,
      entity_count    INTEGER NOT NULL DEFAULT 0,
      error           TEXT,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO entity_index_state (id) VALUES ('default');
  `)
}
