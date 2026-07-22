/**
 * 对 AI 隐藏（ai_exclude）—— Hide from AI
 *
 * 文档根 block 的 `properties.ai_exclude: true` 表示：
 * - 不进向量索引 / RAG / AutoLink
 * - MCP 发现与按 ID 读取均拒绝
 * - 人类 Web 列表 / 编辑 / FTS 搜索仍可用
 */

import {
  readAiExcludeFromProperties,
  setAiExcludeInProperties,
  type BlockRow,
} from '@notefast/core'
import { getDb } from '../db'
import { deleteVector } from './indexer'

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

/** 写入 ai_exclude 到文档 properties，返回更新后的 row */
export function writeDocAiExclude(docId: string, aiExclude: boolean): BlockRow | null {
  const db = getDb()
  const docRow = db
    .query("SELECT * FROM blocks WHERE id = ? AND type = 'document'")
    .get(docId) as BlockRow | undefined
  if (!docRow) return null

  const properties = setAiExcludeInProperties(docRow.properties, aiExclude)
  db.query(
    "UPDATE blocks SET properties = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(properties, docId)

  return db.query('SELECT * FROM blocks WHERE id = ?').get(docId) as BlockRow
}

/**
 * 开启排除后清理 AI 产物：该文档下所有块的向量 + AutoLink 建议。
 */
export async function purgeAiArtifactsForDoc(docId: string): Promise<{ vectors: number; suggestions: number }> {
  const db = getDb()
  const blockIds = db
    .query('SELECT id FROM blocks WHERE root_id = ? OR id = ?')
    .all(docId, docId) as Array<{ id: string }>

  let vectors = 0
  for (const { id } of blockIds) {
    try {
      await deleteVector(id)
      vectors++
    } catch {
      // 向量存储未初始化时忽略
    }
  }

  // AutoLink suggestions：按源块或候选目标所属文档清理
  const placeholders = blockIds.map(() => '?').join(',')
  const ids = blockIds.map((b) => b.id)
  let suggestions = 0
  if (ids.length > 0) {
    const delSource = db
      .query(`DELETE FROM autolink_suggestions WHERE source_block_id IN (${placeholders})`)
      .run(...ids)
    suggestions += Number(delSource.changes ?? 0)
  }
  // 候选里指向该文档的建议（candidates JSON 存 camelCase docId）
  const delCand = db
    .query(`DELETE FROM autolink_suggestions WHERE candidates LIKE ?`)
    .run(`%"docId":"${docId}"%`)
  suggestions += Number(delCand.changes ?? 0)

  return { vectors, suggestions }
}
