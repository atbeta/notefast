/**
 * 变更馈送（change feed）读取 —— entity_changes 表的唯一入口
 *
 * 同步协议地基：
 * - seq（AUTOINCREMENT）是服务端单调递增游标，客户端增量拉取按 seq 推进，
 *   不用 updated_at 做游标（客户端 push 可自带 updated_at，时钟偏慢会导致漏拉）。
 * - updated_at 仅用于 LWW 裁决与「最近编辑」展示语义。
 * - 行由 blocks 表 trigger 自动写入（insert / update / delete），本模块只读。
 *
 * 暂未暴露 API（同步协议落地时消费）：届时清理策略（compaction）在此实现，
 * 超出窗口的客户端走全量快照重同步。
 */

import type { getDb } from '../db'

export type Db = ReturnType<typeof getDb>

export interface EntityChangeRow {
  seq: number
  entity: string
  entity_id: string
  /** 1 = tombstone（软删除或硬删除） */
  is_erased: number
  actor: string
  changed_at: string
}

/** 拉取 sinceSeq 之后的变更（不含 sinceSeq 本身），按 seq 升序 */
export function listChanges(
  db: Db,
  opts: { sinceSeq?: number; limit?: number } = {},
): EntityChangeRow[] {
  return db
    .query(
      `SELECT seq, entity, entity_id, is_erased, actor, changed_at
       FROM entity_changes
       WHERE seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(opts.sinceSeq ?? 0, opts.limit ?? 1000) as EntityChangeRow[]
}

/** 当前最大 seq（客户端 pull 的终点锚点；空表返回 0） */
export function getChangesAnchor(db: Db): number {
  const row = db.query('SELECT COALESCE(MAX(seq), 0) AS s FROM entity_changes').get() as { s: number }
  return row.s
}
