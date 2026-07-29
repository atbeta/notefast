/**
 * block_refs 数据访问 —— 引用关系表的统一读写入口
 *
 * 引用关系不建关联表推导之外的手工维护：block 软删除时由数据访问层
 * 级联清理（deleteRefsTouchingBlocks），反链查询统一走 listBacklinks。
 */

import type { getDb } from '../db'

export type Db = ReturnType<typeof getDb>

/** 删除与任一 block 相关的引用（source 或 target 命中即删）；软删除级联用 */
export function deleteRefsTouchingBlocks(db: Db, ids: string[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  db.query(
    `DELETE FROM block_refs WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
  ).run(...(ids as [string, ...string[]]), ...(ids as [string, ...string[]]))
}

export function findRefByPair(db: Db, sourceId: string, targetId: string): { id: number } | null {
  return (
    (db
      .query('SELECT id FROM block_refs WHERE source_id = ? AND target_id = ?')
      .get(sourceId, targetId) as { id: number } | undefined) ?? null
  )
}

export function insertRef(db: Db, ref: { sourceId: string; targetId: string; refType: string }): void {
  db.query('INSERT INTO block_refs (source_id, target_id, ref_type) VALUES (?, ?, ?)').run(
    ref.sourceId,
    ref.targetId,
    ref.refType,
  )
}

/** 按 id 删除引用；返回是否实际删除（false = 不存在，调用方映射 404） */
export function deleteRefById(db: Db, id: number): boolean {
  return db.query('DELETE FROM block_refs WHERE id = ?').run(id).changes > 0
}

/** 按 (source, target) 对删除引用（不限 ref_type）；返回删除行数 */
export function deleteRefByPair(db: Db, sourceId: string, targetId: string): number {
  return db
    .query('DELETE FROM block_refs WHERE source_id = ? AND target_id = ?')
    .run(sourceId, targetId).changes
}

/** 删除某 source block 发出的指定类型引用（AutoLink 内容变化时旧链重评用）；返回删除行数 */
export function deleteRefsFromSource(db: Db, sourceId: string, refType: string): number {
  return db
    .query('DELETE FROM block_refs WHERE source_id = ? AND ref_type = ?')
    .run(sourceId, refType).changes
}

/** 反链行：引用记录 + 来源 block 信息 */
export interface BacklinkRow {
  id: number
  source_id: string
  target_id: string
  ref_type: string
  created_at: string
  source_content: string
  source_type: string
  source_root_id: string
}

/** 指向 targetId 的反链（新→旧）；limit 不传则全量 */
export function listBacklinks(db: Db, targetId: string, opts: { limit?: number } = {}): BacklinkRow[] {
  let sql = `SELECT r.id, r.source_id, r.target_id, r.ref_type, r.created_at,
                    b.content as source_content, b.type as source_type, b.root_id as source_root_id
             FROM block_refs r
             JOIN blocks b ON b.id = r.source_id
             WHERE r.target_id = ?
             ORDER BY r.created_at DESC`
  const params: (string | number)[] = [targetId]
  if (opts.limit !== undefined) {
    sql += ' LIMIT ?'
    params.push(opts.limit)
  }
  return db.query(sql).all(...(params as [string, ...string[]])) as BacklinkRow[]
}
