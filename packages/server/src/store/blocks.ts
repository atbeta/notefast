/**
 * Block 数据访问层 —— blocks 表读写的统一入口
 *
 * 收敛原先散落在 api / mcp / services / sync / ai 各层的同款 SQL：
 * - 过滤约定只保留一份：列表/树读取默认排除软删除（is_deleted = 0），
 *   需要含已删除行的调用方必须显式选择（getBlockById / includeDeleted）。
 * - 写入约定只保留一份：任何 UPDATE 都带 updated_at = 当前时间（毫秒精度）；
 *   content 变更自动同步 content_hash；软删除统一 is_deleted + delete_id tombstone。
 * - 函数级模块而非 interface：只有一个后端（SQLite）时不冻结接口形状，
 *   未来换远程存储时再以这里为边界提取 interface。
 *
 * 不属于本层：FTS5 检索（dbQueries.runFtsQuery）、向量存储（ai/vectorStore*）、
 * autolink / assets / api_tokens 等自有表的 store。
 */

import type { BlockRow, BlockRevision, DocSnapshot, DocRevisionEntry } from '@notefast/core'
import { buildBlockTree, blocksToMarkdown } from '@notefast/core'
import type { getDb } from '../db'
import { computeContentHash } from '../services/contentHash'

export type Db = ReturnType<typeof getDb>

/** INSERT/批量写入统一使用的时间戳（与 SQL_NOW 同格式：'YYYY-MM-DD HH:MM:SS.sss'，UTC）。
 * 毫秒精度：秒级精度下同秒多次编辑无法区分「最近更新」顺序（列表排序只能靠 rowid 兜底） */
export function nowTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '')
}

/** UPDATE 语句统一使用的当前时间表达式（毫秒精度，与 nowTimestamp 同格式） */
const SQL_NOW = `strftime('%Y-%m-%d %H:%M:%f', 'now')`

// ───────────────────── 单行读取 ─────────────────────

/** 按 id 读 block（含软删除行；调用方自行判断 is_deleted） */
export function getBlockById(db: Db, id: string): BlockRow | null {
  return (db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow | undefined) ?? null
}

/** 按 id 读未删除 block */
export function getLiveBlockById(db: Db, id: string): BlockRow | null {
  return (
    (db.query('SELECT * FROM blocks WHERE id = ? AND is_deleted = 0').get(id) as BlockRow | undefined) ??
    null
  )
}

/** 按 id 读已软删除 block */
export function getDeletedBlockById(db: Db, id: string): BlockRow | null {
  return (
    (db.query('SELECT * FROM blocks WHERE id = ? AND is_deleted = 1').get(id) as BlockRow | undefined) ??
    null
  )
}

/** 按 id 读文档根（type='document'，含软删除行） */
export function getDocById(db: Db, id: string): BlockRow | null {
  return (
    (db.query("SELECT * FROM blocks WHERE id = ? AND type = 'document'").get(id) as BlockRow | undefined) ??
    null
  )
}

/** 按 id 读未删除文档根 */
export function getLiveDocById(db: Db, id: string): BlockRow | null {
  return (
    (db
      .query("SELECT * FROM blocks WHERE id = ? AND type = 'document' AND is_deleted = 0")
      .get(id) as BlockRow | undefined) ?? null
  )
}

/** create / move 需要的父块锚点信息 */
export function getBlockAnchor(db: Db, id: string): { root_id: string; level: number } | null {
  return (
    (db.query('SELECT root_id, level FROM blocks WHERE id = ?').get(id) as
      | { root_id: string; level: number }
      | undefined) ?? null
  )
}

/** 存在性检查（refs 校验等，含软删除行，保持既有语义） */
export function blockExists(db: Db, id: string): boolean {
  return db.query('SELECT id FROM blocks WHERE id = ?').get(id) != null
}

// ───────────────────── 列表 / 树 ─────────────────────

export interface ListDocRowsOptions {
  notebookId?: string
  /** 限定文档 id 集合（sync 归档的选择性导出） */
  docIds?: string[]
  order?: 'updated_desc' | 'updated_asc'
  /** 默认 false：只列未删除文档。软删除文档不应出现在任何列表/导出中 */
  includeDeleted?: boolean
}

/** 文档根行列表（type='document'）；过滤约定（is_deleted / 排序）统一在此 */
export function listDocRows(db: Db, opts: ListDocRowsOptions = {}): BlockRow[] {
  let sql = "SELECT * FROM blocks WHERE type = 'document'"
  const params: string[] = []
  if (!opts.includeDeleted) sql += ' AND is_deleted = 0'
  if (opts.notebookId) {
    sql += ' AND notebook_id = ?'
    params.push(opts.notebookId)
  }
  if (opts.docIds && opts.docIds.length > 0) {
    sql += ` AND id IN (${opts.docIds.map(() => '?').join(',')})`
    params.push(...opts.docIds)
  }
  // updated_at 为毫秒精度，同毫秒碰撞概率极低；仍补 rowid 稳定决胜：
  // ASC = 按入库顺序（归档导出确定性），DESC = 后入库在前（列表「最近更新」语义）
  sql += opts.order === 'updated_asc'
    ? ' ORDER BY updated_at ASC, rowid ASC'
    : ' ORDER BY updated_at DESC, rowid DESC'
  return db.query(sql).all(...(params as [string, ...string[]])) as BlockRow[]
}

/** 未删除文档计数（sync 归档的概要信息用） */
export function countDocRows(db: Db): number {
  const row = db
    .query("SELECT count(*) as c FROM blocks WHERE type = 'document' AND is_deleted = 0")
    .get() as { c: number }
  return row.c
}

/** 回收站：软删除文档根列表（updated_at = 删除时间，新删的在前） */
export function listDeletedDocRows(db: Db): BlockRow[] {
  return db
    .query("SELECT * FROM blocks WHERE type = 'document' AND is_deleted = 1 ORDER BY updated_at DESC, rowid DESC")
    .all() as BlockRow[]
}

/**
 * 文档级拉取：root_id 下全部 block（含文档根本身），按 level, sort 排序。
 * 走 root_id 索引一条查询；buildBlockTree 内部会按 sort 重排子节点，
 * 扁平行顺序不影响建树结果。
 */
export function fetchDocBlocks(db: Db, rootId: string): BlockRow[] {
  return db
    .query('SELECT * FROM blocks WHERE root_id = ? AND is_deleted = 0 ORDER BY level, sort')
    .all(rootId) as BlockRow[]
}

/** 任意子树后代（不含起点本身，仅未删除），按 level, sort 排序 */
export function fetchSubtreeBlocks(db: Db, blockId: string): BlockRow[] {
  return db
    .query(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM blocks WHERE parent_id = ? AND is_deleted = 0
         UNION
         SELECT b.id FROM blocks b JOIN subtree s ON b.parent_id = s.id WHERE b.is_deleted = 0
       )
       SELECT b.* FROM blocks b JOIN subtree s ON b.id = s.id
       ORDER BY b.level, b.sort`,
    )
    .all(blockId) as BlockRow[]
}

/** 已软删除子树的后代 id（不含起点本身），restore 用 */
export function fetchDeletedSubtreeIds(db: Db, blockId: string): string[] {
  const rows = db
    .query(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM blocks WHERE parent_id = ? AND is_deleted = 1
         UNION
         SELECT b.id FROM blocks b JOIN subtree s ON b.parent_id = s.id WHERE b.is_deleted = 1
       )
       SELECT b.id FROM blocks b JOIN subtree s ON b.id = s.id`,
    )
    .all(blockId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/** 直接子块（仅未删除），按 sort 排序 */
export function listChildBlocks(db: Db, parentId: string): BlockRow[] {
  return db
    .query('SELECT * FROM blocks WHERE parent_id = ? AND is_deleted = 0 ORDER BY sort ASC')
    .all(parentId) as BlockRow[]
}

/** 按 id 集合批量读（保持传入顺序无关，调用方不依赖顺序） */
export function getBlocksByIds(db: Db, ids: string[]): BlockRow[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return db.query(`SELECT * FROM blocks WHERE id IN (${placeholders})`).all(...(ids as [string, ...string[]])) as BlockRow[]
}

/** 当前最大子块 sort（追加场景接在其后）；无子块返回 -1 */
export function getMaxChildSort(db: Db, parentId: string): number {
  const row = db
    .query('SELECT COALESCE(MAX(sort), -1) AS m FROM blocks WHERE parent_id = ? AND is_deleted = 0')
    .get(parentId) as { m: number }
  return row.m
}

/** 软删除行（含 delete_id tombstone） */
export type DeletedBlockRow = BlockRow & { delete_id: string }

/** 最近软删除的 blocks（回收站列表），cutoff 为 updated_at 下界 */
export function listRecentlyDeletedBlocks(db: Db, cutoffIso: string, limit = 200): DeletedBlockRow[] {
  return db
    .query(
      'SELECT * FROM blocks WHERE is_deleted = 1 AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?',
    )
    .all(cutoffIso, limit) as DeletedBlockRow[]
}

/**
 * 按来源标识查找文档（外部连接器 upsert 的基础）：返回 docId 或 null。
 * properties 是 JSON 文本，用 json_extract 精确匹配。
 */
export function findDocIdBySource(db: Db, provider: string, externalId: string): string | null {
  const row = db
    .query(
      `SELECT id FROM blocks
       WHERE type = 'document' AND is_deleted = 0
         AND json_extract(properties, '$.source.provider') = ?
         AND json_extract(properties, '$.source.external_id') = ?`,
    )
    .get(provider, externalId) as { id: string } | undefined
  return row?.id ?? null
}

// ───────────────────── 写入 ─────────────────────

/** 新 block 的全部列值（properties/tags 为 JSON 文本；now 同时写入 created_at / updated_at） */
export interface NewBlockRow {
  id: string
  notebook_id: string
  parent_id: string | null
  root_id: string
  type: string
  content: string
  properties?: string
  tags?: string
  status?: string
  ai_exclude?: number
  sort: number
  level: number
  now: string
}

/** 统一 INSERT：列清单只此一份；content_hash 由 content 推导，不允许调用方传错 */
export function insertBlock(db: Db, row: NewBlockRow): void {
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, content_hash, properties, tags, status, ai_exclude, sort, level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.notebook_id,
    row.parent_id,
    row.root_id,
    row.type,
    row.content,
    computeContentHash(row.content),
    row.properties ?? '{}',
    row.tags ?? '[]',
    row.status ?? 'note',
    row.ai_exclude ?? 0,
    row.sort,
    row.level,
    row.now,
    row.now,
  )
}

/** 可更新字段（properties/tags 为 JSON 文本）。content 变更自动同步 content_hash */
export interface BlockPatch {
  content?: string
  properties?: string
  ai_exclude?: number
  type?: string
  status?: string
  tags?: string
  /** 变更来源（user/ai/mcp/sync 等）；仅影响 revision 的 actor 标注，缺省 'user' */
  actor?: string
  /**
   * 跳过 content revision 记录（仅 server 内部整篇替换路径使用：replaceDocContent 已先
   * recordDocSnapshot 整篇快照，标题变更不再单独记一条块级修订，避免重复历史）。
   * 不在 updateBlockSchema（HTTP 校验层）暴露 —— 外部 API 无法绕过审计记录。
   */
  noRevision?: boolean
  /**
   * 元数据变更（tags / ai_exclude 等）不 bump updated_at：
   * 避免「改标签把文档顶到最近更新最前」。同步仍经 entity_changes 变更流发布，
   * 仅多端 LWW 合并时该字段变更不参与时间裁决（官方免配置同步云暂缓，可接受）。
   * 不在 updateBlockSchema（HTTP 校验层）暴露。
   */
  touchUpdatedAt?: boolean
}

/** 每 block 保留的 revision 上限；超出删除最旧的（append-only 防膨胀） */
export const MAX_REVISIONS_PER_BLOCK = 50

/** 内容变更时把「旧值」写入 revision 历史；无历史表或变更为空/无变化时跳过 */
function recordRevision(db: Db, id: string, oldContent: string, actor: string): void {
  const now = nowTimestamp()
  const rev =
    (db
      .query('SELECT COALESCE(MAX(rev), 0) + 1 AS next FROM block_revisions WHERE block_id = ?')
      .get(id) as { next: number }).next
  db.query(
    `INSERT INTO block_revisions (block_id, rev, content, content_hash, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, rev, oldContent, computeContentHash(oldContent), actor, now)
  // 裁剪：保留最近 MAX_REVISIONS_PER_BLOCK 条（rev 小的先删）。
  // LIMIT -1 = 无上限，OFFSET 50 = 取第 51 行及之后（SQLite 方言：负数 LIMIT 视为不限）。
  // 只取第一行即可得到「应保留的最大 rev」，避免删到一半。
  const overflow = db
    .query('SELECT rev FROM block_revisions WHERE block_id = ? ORDER BY rev ASC LIMIT -1 OFFSET ?')
    .all(id, MAX_REVISIONS_PER_BLOCK) as Array<{ rev: number }>
  if (overflow.length > 0) {
    const maxKeep = overflow[0]!.rev - 1
    db.query('DELETE FROM block_revisions WHERE block_id = ? AND rev <= ?').run(id, maxKeep)
  }
}

/** 统一 UPDATE：自动带 updated_at（毫秒精度当前时间）；空 patch 不执行 SQL。
 * content 变更时自动同步 content_hash，并把旧内容写入 block_revisions（历史/回退）。 */
export function updateBlock(db: Db, id: string, patch: BlockPatch): void {
  const updates: string[] = []
  const params: (string | number)[] = []
  const actor = patch.actor ?? 'user'

  if (patch.content !== undefined) {
    // 记录旧值：仅当内容确实变化（hash 不同）时写 revision，避免无操作保存污染历史；
    // noRevision 时跳过（整篇替换路径由 recordDocSnapshot 负责整篇快照，标题不再单独记）
    const current = getBlockById(db, id)
    if (!patch.noRevision && current && current.content !== patch.content) {
      recordRevision(db, id, current.content, actor)
    }
    updates.push('content = ?', 'content_hash = ?')
    params.push(patch.content, computeContentHash(patch.content))
  }
  if (patch.properties !== undefined) {
    updates.push('properties = ?')
    params.push(patch.properties)
  }
  if (patch.ai_exclude !== undefined) {
    updates.push('ai_exclude = ?')
    params.push(patch.ai_exclude)
  }
  if (patch.type !== undefined) {
    updates.push('type = ?')
    params.push(patch.type)
  }
  if (patch.status !== undefined) {
    updates.push('status = ?')
    params.push(patch.status)
  }
  if (patch.tags !== undefined) {
    updates.push('tags = ?')
    params.push(patch.tags)
  }

  if (updates.length === 0) return

  if (patch.touchUpdatedAt !== false) {
    updates.push(`updated_at = ${SQL_NOW}`)
  }
  params.push(id)
  db.query(`UPDATE blocks SET ${updates.join(', ')} WHERE id = ?`).run(
    ...(params as [string, ...string[]]),
  )
}

/** block 的 revision 列表（新→旧）；内容来自历史表 */
export function listBlockRevisions(db: Db, blockId: string, limit = 50): BlockRevision[] {
  return db
    .query(
      `SELECT block_id, rev, content, content_hash, actor, created_at
       FROM block_revisions WHERE block_id = ?
       ORDER BY rev DESC LIMIT ?`,
    )
    .all(blockId, limit) as BlockRevision[]
}

/** 单条 revision；不存在返回 null */
export function getBlockRevision(db: Db, blockId: string, rev: number): BlockRevision | null {
  return (
    (db
      .query(
        `SELECT block_id, rev, content, content_hash, actor, created_at
         FROM block_revisions WHERE block_id = ? AND rev = ?`,
      )
      .get(blockId, rev) as BlockRevision | undefined) ?? null
  )
}

/** 整篇文档快照上限（独立于块级修订）：按 doc_id 裁剪，避免快照挤占单块修订槽位 */
export const MAX_DOC_SNAPSHOTS = 50

/** 记录整篇文档「保存前快照」：旧整篇（标题 + 全部子块）合并为一条 Markdown 存 doc_snapshots。
 * 供整篇替换入口（PUT /docs/:id/markdown 等）在事务内调用 —— 块级 updateBlock 管单块修订，
 * 整篇替换会删旧子块 + 插新子块（绕过它），需在此显式快照才能保留整篇历史。 */
export function recordDocSnapshot(
  db: Db,
  docId: string,
  markdown: string,
  actor = 'editor',
): void {
  const now = nowTimestamp()
  const rev =
    (db
      .query('SELECT COALESCE(MAX(rev), 0) + 1 AS next FROM doc_snapshots WHERE doc_id = ?')
      .get(docId) as { next: number }).next
  db.query(
    `INSERT INTO doc_snapshots (doc_id, rev, content, content_hash, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(docId, rev, markdown, computeContentHash(markdown), actor, now)
  // 按 doc_id 独立裁剪，保留最近 MAX_DOC_SNAPSHOTS 条（LIMIT -1 = SQLite 方言「不限上限」）
  const overflow = db
    .query('SELECT rev FROM doc_snapshots WHERE doc_id = ? ORDER BY rev ASC LIMIT -1 OFFSET ?')
    .all(docId, MAX_DOC_SNAPSHOTS) as Array<{ rev: number }>
  if (overflow.length > 0) {
    const maxKeep = overflow[0]!.rev - 1
    db.query('DELETE FROM doc_snapshots WHERE doc_id = ? AND rev <= ?').run(docId, maxKeep)
  }
}

/** 单条整篇快照；不存在返回 null */
export function getDocSnapshot(db: Db, docId: string, rev: number): DocSnapshot | null {
  return (
    (db
      .query(
        `SELECT doc_id, rev, content, content_hash, actor, created_at
         FROM doc_snapshots WHERE doc_id = ? AND rev = ?`,
      )
      .get(docId, rev) as DocSnapshot | undefined) ?? null
  )
}

/** 整篇快照列表（新→旧） */
export function listDocSnapshots(db: Db, docId: string, limit = 50): DocSnapshot[] {
  return db
    .query(
      `SELECT doc_id, rev, content, content_hash, actor, created_at
       FROM doc_snapshots WHERE doc_id = ?
       ORDER BY rev DESC LIMIT ?`,
    )
    .all(docId, limit) as DocSnapshot[]
}

/**
 * 文档历史面板条目（kind 合并视图）：
 * - kind='snapshot'：整篇快照（doc_snapshots，挂在 doc_id 上）
 * - kind='block'：单块修订（block_revisions，跨本文档全部块）
 * 新→旧。同毫秒多块同时写入会聚拢（created_at 相同 → rev DESC 兜底，与单块纯 rev 序略有差异，
 * 未来做分页时需改为稳定序：created_at DESC + block_id + rev）。
 *
 * 首位追加一条 is_current 合成条目（当前整篇 markdown）：让「当前 vs 上一次保存」的
 * diff 可见（否则最新快照只能对更旧的快照比）。该条目无对应存储行，调用方不得对其回退。
 */
export function listDocRevisions(db: Db, docId: string, limit = 100): DocRevisionEntry[] {
  const rows = db
    .query(
      `SELECT 'snapshot' AS kind, doc_id AS block_id, rev, content, actor, created_at
       FROM doc_snapshots WHERE doc_id = ?
       UNION ALL
       SELECT 'block' AS kind, r.block_id, r.rev, r.content, r.actor, r.created_at
       FROM block_revisions r
       JOIN blocks b ON b.id = r.block_id
       WHERE b.root_id = ? AND b.is_deleted = 0
       ORDER BY created_at DESC, rev DESC
       LIMIT ?`,
    )
    .all(docId, docId, Math.max(1, limit - 1)) as DocRevisionEntry[]
  const current = blocksToMarkdown(buildBlockTree(fetchDocBlocks(db, docId)))
  return [
    {
      kind: 'snapshot',
      block_id: docId,
      // 合成条目：rev 取极大值不与真实修订冲突；前端按 is_current 隐藏回退，不会触发 restore
      rev: Number.MAX_SAFE_INTEGER,
      content: current,
      actor: 'current',
      created_at: nowTimestamp(),
      is_current: true,
    },
    ...rows,
  ]
}

/** 移动：更新自身 parent/root/level/sort（后代传播见 shiftDescendantLevels / reRootDescendants） */
export function moveBlock(
  db: Db,
  id: string,
  target: { parentId: string | null; rootId: string; levelDiff: number; sort: number },
): void {
  db.query(
    `UPDATE blocks SET parent_id = ?, root_id = ?, level = level + ?,
     sort = ?, updated_at = ${SQL_NOW}
     WHERE id = ?`,
  ).run(target.parentId, target.rootId, target.levelDiff, target.sort, id)
}

/** 后代 level 平移（move 的 levelDiff 传播） */
export function shiftDescendantLevels(db: Db, ids: string[], levelDiff: number): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  db.query(`UPDATE blocks SET level = level + ? WHERE id IN (${placeholders})`).run(
    levelDiff,
    ...(ids as [string, ...string[]]),
  )
}

/** 后代 root_id 跟随（跨文档移动传播） */
export function reRootDescendants(db: Db, ids: string[], rootId: string): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  db.query(`UPDATE blocks SET root_id = ? WHERE id IN (${placeholders})`).run(
    rootId,
    ...(ids as [string, ...string[]]),
  )
}

/** 软删除：is_deleted = 1 + delete_id tombstone + updated_at（幂等：已删除行不受影响） */
export function softDeleteBlocks(db: Db, ids: string[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  db.query(
    `UPDATE blocks SET is_deleted = 1, delete_id = lower(hex(randomblob(16))), updated_at = ${SQL_NOW}
     WHERE id IN (${placeholders}) AND is_deleted = 0`,
  ).run(...(ids as [string, ...string[]]))
}

/** 恢复软删除（含子树，由调用方收集 id） */
export function restoreBlocks(db: Db, ids: string[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  db.query(`UPDATE blocks SET is_deleted = 0, updated_at = ${SQL_NOW} WHERE id IN (${placeholders})`).run(
    ...(ids as [string, ...string[]]),
  )
}

/** 物理删除 block 行（永久删除）。FTS 由 AFTER DELETE 触发器清理；其余级联（refs/提及/分享/修订/快照/向量）由调用方在事务内完成。 */
export function hardDeleteBlocks(db: Db, ids: string[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  db.query(`DELETE FROM blocks WHERE id IN (${placeholders})`).run(...(ids as [string, ...string[]]))
}

/** 物理删除 block 的历史修订（永久删除时随块清除） */
export function deleteBlockRevisions(db: Db, ids: string[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  db.query(`DELETE FROM block_revisions WHERE block_id IN (${placeholders})`).run(...(ids as [string, ...string[]]))
}

/** 笔记本下全部未删除 block id（删除笔记本时的级联清理用） */
export function listLiveBlockIdsByNotebook(db: Db, notebookId: string): string[] {
  const rows = db
    .query('SELECT id FROM blocks WHERE notebook_id = ? AND is_deleted = 0')
    .all(notebookId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/** 笔记本删除时级联软删除其下全部 blocks（幂等） */
export function softDeleteByNotebook(db: Db, notebookId: string): void {
  db.query(
    `UPDATE blocks SET is_deleted = 1, delete_id = lower(hex(randomblob(16))), updated_at = ${SQL_NOW}
     WHERE notebook_id = ? AND is_deleted = 0`,
  ).run(notebookId)
}
