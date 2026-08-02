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
  /** 一句话描述（E2，后台 LLM 生成缓存）；NULL = 未生成 */
  description?: string | null
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

/** 实体描述（E2）：达到该提及数才值得生成一句话描述 */
export const DESC_MIN_MENTIONS = 3

// ───────────────────── 别名（E5）─────────────────────

/**
 * 按规范化名查别名字典 → 命中返回规范实体 id。
 * 归并时手工合并会把旧实体名登记为别名，此后抽取同名锚点直接路由到规范实体。
 */
export function resolveAlias(db: Db, name: string): string | null {
  const row = db.query('SELECT entity_id FROM entity_aliases WHERE alias = ?').get(name) as
    | { entity_id: string }
    | undefined
  return row?.entity_id ?? null
}

/** 登记别名（幂等） */
export function addAlias(db: Db, alias: string, entityId: string): void {
  db.query('INSERT OR IGNORE INTO entity_aliases (alias, entity_id) VALUES (?, ?)').run(alias, entityId)
}

/** 把 fromId 实体合并进 intoId（into 存活）：迁移 mentions、搬别名、删 from */
export function mergeEntities(db: Db, fromId: string, intoId: string): void {
  if (fromId === intoId) return
  const from = getEntityById(db, fromId)
  if (!from || !getEntityById(db, intoId)) return

  // 迁移提及（同 block 已存在则跳过）
  db.query(
    `INSERT OR IGNORE INTO entity_mentions (entity_id, block_id, surface, created_at)
     SELECT ?, block_id, surface, created_at FROM entity_mentions WHERE entity_id = ?`,
  ).run(intoId, fromId)
  db.query('DELETE FROM entity_mentions WHERE entity_id = ?').run(fromId)
  // 重算 into 计数（迁移后以真实提及数为准）
  db.query(
    `UPDATE entities SET mention_count = (SELECT COUNT(*) FROM entity_mentions WHERE entity_id = ?), updated_at = datetime('now') WHERE id = ?`,
  ).run(intoId, intoId)

  // 搬别名：from 的规范化名 + display 变体 + from 已有别名 → into
  for (const a of [from.name, normalizeEntityName(from.display)]) {
    if (a && a.length >= 2 && a !== intoId) addAlias(db, a, intoId)
  }
  db.query(
    `INSERT OR IGNORE INTO entity_aliases (alias, entity_id) SELECT alias, ? FROM entity_aliases WHERE entity_id = ?`,
  ).run(intoId, fromId)

  // description 兜底：into 无描述时沿用 from 的
  if (!getEntityById(db, intoId)!.description && from.description) {
    updateEntityDescription(db, intoId, from.description)
  }
  // 删除 from（entity_mentions 已清空；别名经 ON DELETE CASCADE 随行清理）
  db.query('DELETE FROM entities WHERE id = ?').run(fromId)
}

// ───────────────────── 近义重复检测（E5）─────────────────────

export interface DuplicateGroup {
  reason: string
  a: EntityRow
  b: EntityRow
}

/** 编辑距离（小写输入，字符串操作；用于 CJK/ASCII 近义提示） */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[n]!
}

function duplicateReason(a: string, b: string): string | null {
  if (a === b) return null
  // 子串包含：高置信提示（任意语言，长度差至少 1）
  if (b.length >= 3 && a.includes(b) && a.length > b.length) return `「${b}」是「${a}」的一部分`
  if (a.length >= 3 && b.includes(a) && b.length > a.length) return `「${a}」是「${b}」的一部分`
  // 编辑距离 ≤ 2：仅限纯 ASCII 名——CJK 共享常用词（混合/实体/检索…）距离 ≤2 误报率高，
  // 宁可漏检也不建议错并；ASCII 全小写拼写差异（qdrant/qdrnt）是高置信信号
  const asciiOnly = (s: string): boolean => [...s].every((c) => c.charCodeAt(0) <= 0x7f)
  if (
    asciiOnly(a) && asciiOnly(b) &&
    a.length >= 4 && b.length >= 4 &&
    levenshtein(a, b) <= 2
  ) return '名称相近'
  return null
}

/** 高频实体的近义重复候选（供 /entities 页「可能重复」提示；不自动合并） */
export function findPotentialDuplicates(db: Db, limit = 8): DuplicateGroup[] {
  const rows = db
    .query('SELECT * FROM entities ORDER BY mention_count DESC')
    .all() as EntityRow[]
  const out: DuplicateGroup[] = []
  for (let i = 0; i < rows.length && out.length < limit; i++) {
    for (let j = i + 1; j < rows.length && out.length < limit; j++) {
      const reason = duplicateReason(rows[i]!.name, rows[j]!.name)
      if (reason) out.push({ reason, a: rows[i]!, b: rows[j]! })
    }
  }
  return out
}

/** 需要生成描述的实体（mention_count ≥ 阈值且尚无描述），按提及数倒序 */
export function listEntitiesNeedingDescription(db: Db, limit: number): EntityRow[] {
  return db
    .query(
      `SELECT * FROM entities
       WHERE mention_count >= ? AND description IS NULL
       ORDER BY mention_count DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(DESC_MIN_MENTIONS, limit) as EntityRow[]
}

/** 写入实体一句话描述（幂等：已存在则更新，失败重试语义由调用方保证） */
export function updateEntityDescription(db: Db, id: string, description: string): void {
  db.query(
    `UPDATE entities SET description = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(description, id)
}

/** 实体的全部提及（人类视角全量：不过滤任何文档状态；ai_exclude 已 purge 天然安全） */export interface EntityMentionView extends EntityMentionRow {
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

/** 本篇文档提及的实体（去重；面板数据源） */export interface DocEntityView {
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
