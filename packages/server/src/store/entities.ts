/**
 * entities / entity_mentions 数据访问 —— 图谱实体层的统一读写入口
 *
 * 图谱数据层有两类边：
 * - block_refs（block↔block 引用，见 store/refs.ts）
 * - entity_mentions（block→entity 提及，本文件）
 *
 * 归并策略：规范化名精确匹配（entities.name UNIQUE），不做 embedding 消歧——
 * 重复实体比错误合并代价小。mention_count 是冗余计数（列表排序 + 归零清理），
 * 由 addMention / 删除路径同步维护；归零即删实体（空实体只污染列表，重建重抽即可）。
 *
 * 软删除不触发 FK 级联：block 软删由 deleteMentionsTouchingBlocks 显式清理
 * （与 deleteRefsTouchingBlocks 同挂一处）。
 */

import type { getDb } from '../db'

export type Db = ReturnType<typeof getDb>

export interface EntityRow {
  id: string
  name: string
  display: string
  kind: string
  mention_count: number
  created_at: string
  updated_at: string
}

export interface EntityMentionRow {
  id: number
  entity_id: string
  block_id: string
  surface: string
  created_at: string
}

/**
 * 规范化实体名：trim → lowercase → 去首尾标点 → 压缩内部空白。
 * 全角字符不转换（保持简单，宁多实体勿错并）。归并键，返回 '' 表示无有效名。
 */
export function normalizeEntityName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\p{P}+/gu, '')
    .replace(/\p{P}+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 按规范化名查实体 */
export function findEntityByName(db: Db, name: string): EntityRow | null {
  return (
    (db.query('SELECT * FROM entities WHERE name = ?').get(name) as EntityRow | undefined) ?? null
  )
}

/** 按 id 查实体 */
export function getEntityById(db: Db, id: string): EntityRow | null {
  return (db.query('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined) ?? null
}

/**
 * 按规范化名 upsert 实体：已存在直接返回（display/kind 保留首个写法），
 * 不存在则插入（mention_count 由 addMention 维护，初始 0）。
 */
export function upsertEntity(
  db: Db,
  input: { name: string; display: string; kind: string },
): EntityRow {
  const existing = findEntityByName(db, input.name)
  if (existing) return existing
  const id = crypto.randomUUID()
  db.query(
    `INSERT INTO entities (id, name, display, kind, mention_count) VALUES (?, ?, ?, ?, 0)`,
  ).run(id, input.name, input.display, input.kind)
  return getEntityById(db, id)!
}

/** 登记一条提及（UNIQUE(entity_id, block_id) 幂等）；新插入时 mention_count +1。返回是否为新提及 */
export function addMention(db: Db, entityId: string, blockId: string, surface: string): boolean {
  const inserted = db
    .query('INSERT OR IGNORE INTO entity_mentions (entity_id, block_id, surface) VALUES (?, ?, ?)')
    .run(entityId, blockId, surface).changes
  if (inserted > 0) {
    db.query(
      `UPDATE entities SET mention_count = mention_count + 1, updated_at = datetime('now') WHERE id = ?`,
    ).run(entityId)
    return true
  }
  return false
}

/** 递减计数并清理归零实体（空实体只污染列表，重抽即可重建） */
function decrementAndSweep(db: Db, counts: Map<string, number>): void {
  for (const [entityId, n] of counts) {
    db.query(
      `UPDATE entities SET mention_count = mention_count - ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(n, entityId)
  }
  db.query('DELETE FROM entities WHERE mention_count <= 0').run()
}

/**
 * 删除某 block 的全部提及（内容更新重抽前的双清理之一）。
 * 返回被删提及涉及的实体 id（含可能已归零清理的，供调用方记录/断言）。
 */
export function deleteMentionsFromSource(db: Db, blockId: string): string[] {
  const rows = db
    .query('SELECT entity_id, count(*) AS c FROM entity_mentions WHERE block_id = ? GROUP BY entity_id')
    .all(blockId) as Array<{ entity_id: string; c: number }>
  if (rows.length === 0) return []
  db.query('DELETE FROM entity_mentions WHERE block_id = ?').run(blockId)
  decrementAndSweep(db, new Map(rows.map((r) => [r.entity_id, r.c])))
  return rows.map((r) => r.entity_id)
}

/** 软删除级联：删除与任一批量 block 相关的提及；与 deleteRefsTouchingBlocks 同挂一处 */
export function deleteMentionsTouchingBlocks(db: Db, ids: string[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .query(
      `SELECT entity_id, count(*) AS c FROM entity_mentions WHERE block_id IN (${placeholders}) GROUP BY entity_id`,
    )
    .all(...(ids as [string, ...string[]])) as Array<{ entity_id: string; c: number }>
  if (rows.length === 0) return
  db.query(`DELETE FROM entity_mentions WHERE block_id IN (${placeholders})`).run(
    ...(ids as [string, ...string[]]),
  )
  decrementAndSweep(db, new Map(rows.map((r) => [r.entity_id, r.c])))
}

// ───────────────────── 查询（REST / 召回路用）─────────────────────

/** 实体列表：mention_count 倒序；q 匹配 name / display 子串（不区分大小写） */
export function listEntities(db: Db, opts: { q?: string; limit?: number } = {}): EntityRow[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50))
  const q = (opts.q ?? '').trim()
  if (!q) {
    return db
      .query('SELECT * FROM entities ORDER BY mention_count DESC, updated_at DESC LIMIT ?')
      .all(limit) as EntityRow[]
  }
  const pattern = `%${q.toLowerCase()}%`
  return db
    .query(
      `SELECT * FROM entities
       WHERE lower(name) LIKE ? OR lower(display) LIKE ?
       ORDER BY mention_count DESC, updated_at DESC LIMIT ?`,
    )
    .all(pattern, pattern, limit) as EntityRow[]
}

/** 实体的全部提及（人类视角全量：不过滤任何文档状态；ai_exclude 已 purge 天然安全） */
export interface EntityMentionView extends EntityMentionRow {
  doc_id: string
  doc_title: string
  doc_status: string
  block_content: string
}

export function listEntityMentions(db: Db, entityId: string): EntityMentionView[] {
  return db
    .query(
      `SELECT m.id, m.entity_id, m.block_id, m.surface, m.created_at,
              b.root_id AS doc_id, d.content AS doc_title, d.status AS doc_status,
              b.content AS block_content
       FROM entity_mentions m
       JOIN blocks b ON b.id = m.block_id AND b.is_deleted = 0
       LEFT JOIN blocks d ON d.id = b.root_id
       WHERE m.entity_id = ?
       ORDER BY m.created_at DESC`,
    )
    .all(entityId) as EntityMentionView[]
}

/** 本篇文档提及的实体（去重；面板数据源） */
export interface DocEntityView {
  id: string
  display: string
  kind: string
  mention_count: number
  /** 本篇中的原文写法（取最早一条） */
  surface: string
}

export function listDocEntities(db: Db, docId: string): DocEntityView[] {
  return db
    .query(
      `SELECT e.id, e.display, e.kind, e.mention_count, MIN(m.surface) AS surface
       FROM entity_mentions m
       JOIN entities e ON e.id = m.entity_id
       JOIN blocks b ON b.id = m.block_id AND b.is_deleted = 0
       WHERE b.root_id = ?
       GROUP BY e.id
       ORDER BY e.mention_count DESC`,
    )
    .all(docId) as DocEntityView[]
}
