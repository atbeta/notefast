/**
 * vault_unresolved_links 数据访问 —— 未解析 wikilink 目标的统一读写入口（RFC 0002 §引用解析）。
 *
 * 一行 = 「某个源块引用了某个尚不存在的目标名（+锚点）」。目标文件后来出现时按
 * `(notebook_id, target_name)` 反查，补建引用并删掉这些行。
 */

import type { getDb } from '../db'

type Db = ReturnType<typeof getDb>

export interface UnresolvedLinkRow {
  notebook_id: string
  source_block_id: string
  target_name: string
  anchor: string
}

export interface UnresolvedLinkInput {
  source_block_id: string
  target_name: string
  anchor: string
}

/** 整块重写：先删这些源块的未解析记录，再写入本次解析结果 */
export function replaceUnresolvedLinksForBlocks(
  db: Db,
  notebookId: string,
  sourceBlockIds: string[],
  rows: UnresolvedLinkInput[],
): void {
  db.transaction(() => {
    if (sourceBlockIds.length > 0) {
      const placeholders = sourceBlockIds.map(() => '?').join(',')
      db.query(`DELETE FROM vault_unresolved_links WHERE source_block_id IN (${placeholders})`).run(
        ...(sourceBlockIds as [string, ...string[]]),
      )
    }
    if (rows.length === 0) return
    const insert = db.query(
      'INSERT OR IGNORE INTO vault_unresolved_links (notebook_id, source_block_id, target_name, anchor) VALUES (?, ?, ?, ?)',
    )
    for (const row of rows) {
      insert.run(notebookId, row.source_block_id, row.target_name, row.anchor)
    }
  })()
}

/** 只追加（不清空既有记录）：回收站删除时把「谁引用过这个名字」先记下来 */
export function insertUnresolvedLinks(db: Db, notebookId: string, rows: UnresolvedLinkInput[]): void {
  if (rows.length === 0) return
  const insert = db.query(
    'INSERT OR IGNORE INTO vault_unresolved_links (notebook_id, source_block_id, target_name, anchor) VALUES (?, ?, ?, ?)',
  )
  db.transaction(() => {
    for (const row of rows) insert.run(notebookId, row.source_block_id, row.target_name, row.anchor)
  })()
}

export function deleteUnresolvedForBlocks(db: Db, sourceBlockIds: string[]): void {
  if (sourceBlockIds.length === 0) return
  const placeholders = sourceBlockIds.map(() => '?').join(',')
  db.query(`DELETE FROM vault_unresolved_links WHERE source_block_id IN (${placeholders})`).run(
    ...(sourceBlockIds as [string, ...string[]]),
  )
}

/** 按目标名（大小写不敏感）反查待解析记录，用于「新文件出现后补建引用」 */
export function listUnresolvedByTargetNames(
  db: Db,
  notebookId: string,
  names: string[],
): UnresolvedLinkRow[] {
  const out: UnresolvedLinkRow[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const normalized = name.trim().toLowerCase()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    const rows = db
      .query(
        `SELECT * FROM vault_unresolved_links
         WHERE notebook_id = ? AND lower(target_name) = ?
         ORDER BY source_block_id ASC`,
      )
      .all(notebookId, normalized) as UnresolvedLinkRow[]
    out.push(...rows)
  }
  return out
}

export function countUnresolvedLinks(db: Db, notebookId: string): number {
  return (
    db
      .query('SELECT count(*) AS c FROM vault_unresolved_links WHERE notebook_id = ?')
      .get(notebookId) as { c: number }
  ).c
}

/** 侧栏「未解析链接」用的聚合视图：按目标名分组，附来源文档 */
export interface UnresolvedTargetGroup {
  target_name: string
  anchor: string
  /** 引用该目标的源块数 */
  count: number
  /** 来源文档（按 rel_path 排序；rel_path 缺失时保留 doc_id，前端退化为跳文档） */
  sources: Array<{ doc_id: string; rel_path: string | null }>
}

/**
 * 按目标名聚合未解析引用。
 *
 * 为什么按 `(target_name, anchor)` 分组而不是逐行：用户关心的是「我想链的那篇笔记还不存在」，
 * 而不是每个引用点；同一个目标被多少篇引用才是行动依据。
 * 每组的来源最多 `maxSourcesPerTarget` 条，避免热门目标把响应撑爆（count 仍是全量）。
 */
export function listUnresolvedTargets(
  db: Db,
  notebookId: string,
  opts: { maxSourcesPerTarget?: number; maxTargets?: number } = {},
): { total: number; targets: UnresolvedTargetGroup[] } {
  const maxSources = opts.maxSourcesPerTarget ?? 5
  const maxTargets = opts.maxTargets ?? 200
  const rows = db
    .query(
      `SELECT u.target_name AS target_name, u.anchor AS anchor,
              b.root_id AS doc_id, vf.rel_path AS rel_path
         FROM vault_unresolved_links u
         JOIN blocks b ON b.id = u.source_block_id
    LEFT JOIN vault_files vf ON vf.doc_id = b.root_id AND vf.deleted_at IS NULL
        WHERE u.notebook_id = ?
        ORDER BY u.target_name ASC, vf.rel_path ASC`,
    )
    .all(notebookId) as Array<{
    target_name: string
    anchor: string
    doc_id: string | null
    rel_path: string | null
  }>

  const byKey = new Map<string, UnresolvedTargetGroup>()
  for (const row of rows) {
    const key = `${row.target_name}\u0000${row.anchor}`
    let group = byKey.get(key)
    if (!group) {
      group = { target_name: row.target_name, anchor: row.anchor, count: 0, sources: [] }
      byKey.set(key, group)
    }
    group.count += 1
    if (!row.doc_id) continue
    if (group.sources.length >= maxSources) continue
    if (group.sources.some((s) => s.doc_id === row.doc_id)) continue
    group.sources.push({ doc_id: row.doc_id, rel_path: row.rel_path })
  }

  const targets = [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.target_name.localeCompare(b.target_name),
  )
  return { total: rows.length, targets: targets.slice(0, maxTargets) }
}
