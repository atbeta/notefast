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
import { getBlockById, getBlocksByIds, getDocById } from '../store/blocks'

/** 从 document 行判断是否 AI 排除 */
export function isDocRowAiExcluded(docRow: BlockRow | null | undefined): boolean {
  if (!docRow || docRow.type !== 'document') return false
  return readAiExclude(docRow)
}

/** 按文档 ID（root）判断是否 AI 排除 */
export function isDocAiExcluded(docId: string): boolean {
  const db = getDb()
  return isDocRowAiExcluded(getDocById(db, docId))
}

/**
 * 按任意 blockId 判断其所属文档是否 AI 排除。
 * document 根用自身 id；子块用 root_id。
 */
export function isBlockAiExcluded(blockId: string): boolean {
  const db = getDb()
  const row = getBlockById(db, blockId)
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
  // getBlocksByIds 无 type 过滤，内存补齐原 type='document' 条件
  const rows = getBlocksByIds(db, ids)
  for (const r of rows) {
    if (r.type === 'document' && r.ai_exclude === 1) excluded.add(r.id)
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
  // getBlocksByIds 无 type 过滤，内存补齐原 type='document' 条件
  const rows = getBlocksByIds(db, ids)
  for (const r of rows) {
    if (r.type === 'document' && r.status === status) matched.add(r.id)
  }
  return matched
}

/** 取某文档下所有 block id（含 root，仅未删除），用于批量 purge / reindex */
export function loadDocBlockIds(docId: string): string[] {
  const rows = getDb()
    .query('SELECT id FROM blocks WHERE (root_id = ? OR id = ?) AND is_deleted = 0')
    .all(docId, docId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/**
 * 读取 ai_exclude 的旧值（在 writeDocAiExclude 之前调用以判定切换方向）。
 * docId 不存在时返回 null（调用方应另行处理 not_found）。
 */
export function readDocAiExclude(docId: string): boolean | null {
  const row = getDocById(getDb(), docId)
  if (!row) return null
  return row.ai_exclude === 1
}

/**
 * 按任意 blockId 判断其所属文档是否处于 lifecycle 排除状态（inbox / archived）。
 * 与 hybridSearch 默认 drop 语义一致：收集箱与归档不进 RAG，也不进向量索引。
 * document 根用自身 id；子块用 root_id 解析文档根。
 */
export function isBlockLifecycleExcluded(blockId: string): boolean {
  const db = getDb()
  const row = getBlockById(db, blockId)
  if (!row) return false
  if (row.type === 'document') {
    return row.status === 'inbox' || row.status === 'archived'
  }
  const docId = row.root_id
  if (!docId) return false
  const docRow = getDocById(db, docId)
  if (!docRow) return false
  return docRow.status === 'inbox' || docRow.status === 'archived'
}

/**
 * 批量：哪些 root_id 处于 lifecycle 排除状态（inbox ∪ archived）。
 * 与 indexer / hybridSearch 的 drop 集合语义一致。
 */
export function loadLifecycleExcludedDocIds(docIds: Iterable<string>): Set<string> {
  const inbox = loadInboxDocIds(docIds)
  if (inbox.size === 0) return loadArchivedDocIds(docIds)
  const out = new Set<string>(inbox)
  for (const id of loadArchivedDocIds(docIds)) out.add(id)
  return out
}
