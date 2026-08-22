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

/** 递减计数并清理本次归零的实体（只扫本次触及的 id，避免误删词典新建的 0 提及实体） */
function decrementAndSweep(db: Db, counts: Map<string, number>): void {
  if (counts.size === 0) return
  for (const [entityId, n] of counts) {
    db.query(
      `UPDATE entities SET mention_count = mention_count - ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(n, entityId)
  }
  const ids = [...counts.keys()]
  const ph = ids.map(() => '?').join(',')
  db.query(`DELETE FROM entities WHERE mention_count <= 0 AND id IN (${ph})`).run(...ids)
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

/** 实体列表：mention_count 倒序；q 匹配 name / display / 别名（entity_aliases）子串 */
export function listEntities(
  db: Db,
  opts: { q?: string; limit?: number; extraNames?: string[] } = {},
): EntityRow[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50))
  const q = (opts.q ?? '').trim()
  const extraNames = [...new Set((opts.extraNames ?? []).map((n) => n.trim()).filter((n) => n.length >= 2))]
  if (!q && extraNames.length === 0) {
    return db
      .query('SELECT * FROM entities ORDER BY mention_count DESC, updated_at DESC LIMIT ?')
      .all(limit) as EntityRow[]
  }

  const conds: string[] = []
  const params: Array<string | number> = []
  if (q) {
    const pattern = `%${q.toLowerCase()}%`
    conds.push(`lower(e.name) LIKE ? OR lower(e.display) LIKE ? OR lower(IFNULL(a.alias, '')) LIKE ?`)
    params.push(pattern, pattern, pattern)
  }
  if (extraNames.length > 0) {
    conds.push(`e.name IN (${extraNames.map(() => '?').join(',')})`)
    params.push(...extraNames)
  }
  return db
    .query(
      `SELECT DISTINCT e.* FROM entities e
       LEFT JOIN entity_aliases a ON a.entity_id = e.id
       WHERE ${conds.join(' OR ')}
       ORDER BY e.mention_count DESC, e.updated_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as EntityRow[]
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

/**
 * 版本变体归并：「既有主名 + 独立版本号后缀」（codemirror 6 → codemirror、react v18 → react）
 * 路由到主名实体 id；主名不是既有实体时返回 null（不新建、不猜测）。
 * 仅处理显式分隔的后缀（空格/点 + 可选 v + 数字）——名称本身含数字（fts5、bm25）不动，
 * 保持「宁多勿错并」。
 */
export function resolveVersionVariant(db: Db, name: string): string | null {
  const m = name.match(/^(.+?)[\s.]+v?\d+(?:\.\d+)*$/)
  if (!m) return null
  const base = m[1]!
  if (base.length < 2) return null
  const hit = findEntityByName(db, base)
  return hit ? hit.id : null
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

  // 多步写入包事务：任一失败整体回滚，不留「提及已迁但旧实体未删」的中间态
  db.transaction(() => {
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
  })()
}

// ───────────────────── 近义重复检测（E5）─────────────────────

export interface DuplicateGroup {
  reason: string
  /**
   * 信号分桶：
   * - typo：ASCII 拼写变体（编辑距离），高置信同义 → 自动合并信号
   * - substring：子串包含（「数据库」⊂「向量数据库」），可能是上下位而非同义，
   *   只作为「词典建议」展示，不自动合（错误合并污染共现边与实体检索，代价大于漏合）
   */
  signal: 'typo' | 'substring'
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

function duplicateReason(a: string, b: string): { reason: string; signal: DuplicateGroup['signal'] } | null {
  if (a === b) return null
  // 子串包含：低置信同义信号（上下位/简称均可能），仅作词典建议
  if (b.length >= 3 && a.includes(b) && a.length > b.length) {
    return { reason: `「${b}」是「${a}」的一部分`, signal: 'substring' }
  }
  if (a.length >= 3 && b.includes(a) && b.length > a.length) {
    return { reason: `「${a}」是「${b}」的一部分`, signal: 'substring' }
  }
  // 编辑距离 ≤2：仅限纯 ASCII 名且长度 ≥5 才视为拼写变体自动合并信号——
  // CJK 共享常用词（混合/实体/检索…）距离 ≤2 误报率高；长度 4 的 ASCII 名
  // （rust/rush、vite/vitex 是真实不同实体）也下放词典建议，宁漏合不错合
  const asciiOnly = (s: string): boolean => [...s].every((c) => c.charCodeAt(0) <= 0x7f)
  if (
    asciiOnly(a) && asciiOnly(b) &&
    a.length >= 5 && b.length >= 5 &&
    levenshtein(a, b) <= 2
  ) return { reason: '名称相近', signal: 'typo' }
  return null
}

/** 近义检测的候选池：按 mention_count 取 top-N（两两比较只在池内做，不再全表 O(n²)） */
const DUPLICATE_TOP_N = 200
/** 从池中取多少个最高频实体名去做长尾子串展开（单个 LIKE 反查，防 N+1） */
const DUPLICATE_EXPAND_N = 20
/** 长尾子串伙伴上限（防极端库单次返回爆炸） */
const DUPLICATE_PARTNER_MAX = 100

/**
 * 高频实体的近义重复候选（供 /entities 页提示；typo 自动合并，substring 词典建议）。
 *
 * 复杂度控制：候选 = top-N（mention_count 倒序）+ 长尾子串伙伴（单条 SQL 用
 * instr 双向展开 top 名的包含关系）。typo（Levenshtein）只在 top-N 池内两两比较；
 * substring 对 top×top 与 top×长尾都覆盖——长尾伙伴不再靠全表两两 O(n²) 捞。
 */
export function findPotentialDuplicates(db: Db, limit = 8): DuplicateGroup[] {
  const topRows = db
    .query(
      `SELECT * FROM entities ORDER BY mention_count DESC, rowid ASC LIMIT ?`,
    )
    .all(DUPLICATE_TOP_N) as EntityRow[]

  // 长尾子串伙伴：单条 SQL，对展开名双向 instr（伙伴包含展开名 / 展开名包含伙伴）
  const expandNames = topRows.slice(0, DUPLICATE_EXPAND_N).map((r) => r.name)
  const ors: string[] = []
  const params: string[] = []
  for (const name of expandNames) {
    ors.push('instr(e.name, ?) > 0')
    params.push(name)
    ors.push('instr(?, e.name) > 0')
    params.push(name)
  }
  const partnerRows = expandNames.length === 0
    ? []
    : db.query(
        `SELECT e.* FROM entities e
         WHERE length(e.name) >= 3 AND (${ors.join(' OR ')})
         ORDER BY e.mention_count DESC LIMIT ?`,
      ).all(...params, DUPLICATE_PARTNER_MAX) as EntityRow[]

  const seen = new Set<string>()
  const out: DuplicateGroup[] = []
  const push = (signal: DuplicateGroup['signal'], reason: string, a: EntityRow, b: EntityRow) => {
    if (a.id === b.id) return
    const key = [a.id, b.id].sort().join('|')
    if (seen.has(key)) return
    seen.add(key)
    out.push({ reason, signal, a, b })
  }

  // top×top：两种信号都检
  for (let i = 0; i < topRows.length; i++) {
    for (let j = i + 1; j < topRows.length; j++) {
      const hit = duplicateReason(topRows[i]!.name, topRows[j]!.name)
      if (hit) push(hit.signal, hit.reason, topRows[i]!, topRows[j]!)
    }
  }
  // top×长尾：只检子串（长尾名不参与 Levenshtein——拼写变体几乎总在高频区）
  for (const top of topRows.slice(0, DUPLICATE_EXPAND_N)) {
    for (const partner of partnerRows) {
      const hit = duplicateReason(top.name, partner.name)
      if (hit && hit.signal === 'substring') push(hit.signal, hit.reason, top, partner)
    }
  }

  // 高频对优先（池内已按 mention_count 降序比较，天然近似；精确排序代价低也补一个）
  out.sort((x, y) => Math.max(y.a.mention_count, y.b.mention_count) - Math.max(x.a.mention_count, x.b.mention_count))
  return out.slice(0, limit)
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
