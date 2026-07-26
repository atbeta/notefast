/**
 * 对 AI 隐藏（ai_exclude）—— 纯查询判定
 *
 * 从 aiExclude.ts 拆出的无副作用部分（只依赖 db + core），
 * 供 indexer / autoLink / aiRuntime 等静态引用，避免
 * 「aiExclude → indexer → aiRuntime → autoLink → aiExclude」循环依赖。
 * 写 / purge / reindex 等副作用仍在 aiExclude.ts。
 */

import { readAiExclude, type BlockRow } from '@notefast/core'
import { getDb } from '../db'

/** 从 document 行判断是否 AI 排除 */
export function isDocRowAiExcluded(docRow: BlockRow | null | undefined): boolean {
  if (!docRow || docRow.type !== 'document') return false
  return readAiExclude(docRow)
}

/** 按文档 ID（root）判断是否 AI 排除 */
export function isDocAiExcluded(docId: string): boolean {
  const db = getDb()
  const row = db
    .query("SELECT * FROM blocks WHERE id = ? AND type = 'document'")
    .get(docId) as BlockRow | undefined
  return isDocRowAiExcluded(row)
}

/**
 * 按任意 blockId 判断其所属文档是否 AI 排除。
 * document 根用自身 id；子块用 root_id。
 */
export function isBlockAiExcluded(blockId: string): boolean {
  const db = getDb()
  const row = db
    .query('SELECT id, type, root_id, ai_exclude FROM blocks WHERE id = ?')
    .get(blockId) as Pick<BlockRow, 'id' | 'type' | 'root_id' | 'ai_exclude'> | undefined
  if (!row) return false
  if (row.type === 'document') return row.ai_exclude === 1
  return isDocAiExcluded(row.root_id)
}

/** 批量：哪些 root_id 被排除（给检索结果过滤用） */
export function loadAiExcludedDocIds(docIds: Iterable<string>): Set<string> {
  const ids = [...new Set([...docIds].filter(Boolean))]
  const excluded = new Set<string>()
  if (ids.length === 0) return excluded
  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .query(`SELECT id, ai_exclude FROM blocks WHERE type = 'document' AND id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; ai_exclude: number }>
  for (const r of rows) {
    if (r.ai_exclude === 1) excluded.add(r.id)
  }
  return excluded
}

/** 批量：哪些 root_id 是收集箱（RAG 默认排除，与主列表一致） */
export function loadInboxDocIds(docIds: Iterable<string>): Set<string> {
  return loadDocIdsByStatus(docIds, 'inbox')
}

/** 批量：哪些 root_id 已归档（RAG 默认软排除，可经 includeArchived 显式包含） */
export function loadArchivedDocIds(docIds: Iterable<string>): Set<string> {
  return loadDocIdsByStatus(docIds, 'archived')
}

/** 批量：哪些 root_id 处于指定 status */
function loadDocIdsByStatus(docIds: Iterable<string>, status: string): Set<string> {
  const ids = [...new Set([...docIds].filter(Boolean))]
  const matched = new Set<string>()
  if (ids.length === 0) return matched
  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .query(`SELECT id, status FROM blocks WHERE type = 'document' AND id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; status: string }>
  for (const r of rows) {
    if (r.status === status) matched.add(r.id)
  }
  return matched
}

/** 取某文档下所有 block id（含 root），用于批量 purge / reindex */
export function loadDocBlockIds(docId: string): string[] {
  const rows = getDb()
    .query('SELECT id FROM blocks WHERE root_id = ? OR id = ?')
    .all(docId, docId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/**
 * 读取 ai_exclude 的旧值（在 writeDocAiExclude 之前调用以判定切换方向）。
 * docId 不存在时返回 null（调用方应另行处理 not_found）。
 */
export function readDocAiExclude(docId: string): boolean | null {
  const row = getDb()
    .query("SELECT ai_exclude FROM blocks WHERE id = ? AND type = 'document'")
    .get(docId) as { ai_exclude: number } | undefined
  if (!row) return null
  return row.ai_exclude === 1
}
