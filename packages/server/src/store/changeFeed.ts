/**
 * 变更馈送（change feed）—— entity_changes 表的唯一入口
 *
 * 同步协议地基：
 * - seq（AUTOINCREMENT）是**本设备**单调递增游标——只在发布端自己的
 *   changes/<device_id>/ namespace 内有意义，不同设备的 seq 空间互相独立；
 *   客户端增量拉取按 per-device 高水位推进，不用 updated_at 做游标
 *   （客户端 push 可自带 updated_at，时钟偏慢会导致漏拉）。
 * - updated_at 仅用于 LWW 裁决与「最近编辑」展示语义。
 * - 行由 blocks 表 trigger 自动写入（insert / update / delete）。
 *
 * 消费方是多端同步协议（sync/protocol.ts）：publish 按本端 seq 把增量导出为
 * 本端 namespace 分段，compaction 覆盖全量快照后以本端快照锚点为下界调
 * pruneChanges 裁剪本地历史行；超出快照窗口的端走全量快照重同步。
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
  /** trigger 记录的事件后行 updated_at（毫秒精度；014 之前的旧行为 NULL）。
   *  软删事件 = 删除时刻，发布端据此生成 SyncChange.deleted_at 供消费端 LWW */
  entity_updated_at: string | null
}

/** 拉取 sinceSeq 之后的变更（不含 sinceSeq 本身），按 seq 升序 */
export function listChanges(
  db: Db,
  opts: { sinceSeq?: number; limit?: number } = {},
): EntityChangeRow[] {
  return db
    .query(
      `SELECT seq, entity, entity_id, is_erased, actor, changed_at, entity_updated_at
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

/**
 * 裁剪 seq <= upToSeq 的历史行（同步 compaction 专用），返回删除行数。
 * 唯一下界 = 已被远端快照覆盖的本端 seq（compactChanges 成功后的本端快照锚点）：
 * 快照已兜底该区间，首次/超窗端走快照重同步，本地不再需要这段历史。
 * upToSeq <= 0（空库快照锚点 / 未配置同步）时不裁——该区间没有任何快照覆盖，
 * 本地首次发布（publishedSeq=0）需从 0 全量回放，裁了会静默漏同步。
 * 删除不重置 sqlite_sequence（AUTOINCREMENT），后续变更 seq 继续递增不回退。
 */
export function pruneChanges(db: Db, upToSeq: number): number {
  if (upToSeq <= 0) return 0
  return db.query('DELETE FROM entity_changes WHERE seq <= ?').run(upToSeq).changes
}
