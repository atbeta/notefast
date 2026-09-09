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
