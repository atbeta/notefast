/**
 * 对 AI 隐藏（ai_exclude）—— 纯查询判定
 *
 * 从 aiExclude.ts 拆出的无副作用部分（只依赖 db + core），
 * 供 indexer / autoLink / aiRuntime 等静态引用，避免
 * 「aiExclude → indexer → aiRuntime → autoLink → aiExclude」循环依赖。
 * 写 / purge / reindex 等副作用仍在 aiExclude.ts。
 */

import { readAiExcludeFromProperties, type BlockRow } from '@notefast/core'
import { getDb } from '../db'

/** 从 document 行判断是否 AI 排除 */
export function isDocRowAiExcluded(docRow: BlockRow | null | undefined): boolean {
  if (!docRow || docRow.type !== 'document') return false
  return readAiExcludeFromProperties(docRow.properties)
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
    .query('SELECT id, type, root_id, properties FROM blocks WHERE id = ?')
    .get(blockId) as Pick<BlockRow, 'id' | 'type' | 'root_id' | 'properties'> | undefined
  if (!row) return false
  if (row.type === 'document') return readAiExcludeFromProperties(row.properties)
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
    .query(`SELECT id, properties FROM blocks WHERE type = 'document' AND id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; properties: string }>
  for (const r of rows) {
    if (readAiExcludeFromProperties(r.properties)) excluded.add(r.id)
  }
  return excluded
}

/** 取某文档下所有 block id（含 root），用于批量 purge / reindex */
export function loadDocBlockIds(docId: string): string[] {
  const rows = getDb()
    .query('SELECT id FROM blocks WHERE root_id = ? OR id = ?')
    .all(docId, docId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/**
 * 读取 properties.ai_exclude 的旧值（在 writeDocAiExclude 之前调用以判定切换方向）。
 * docId 不存在时返回 null（调用方应另行处理 not_found）。
 */
export function readDocAiExclude(docId: string): boolean | null {
  const row = getDb()
    .query("SELECT properties FROM blocks WHERE id = ? AND type = 'document'")
    .get(docId) as { properties: string } | undefined
  if (!row) return null
  return readAiExcludeFromProperties(row.properties)
}
