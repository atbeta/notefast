/**
 * 对 AI 隐藏（ai_exclude）—— Hide from AI
 *
 * 文档根 block 的 `properties.ai_exclude: true` 表示：
 * - 不进向量索引 / RAG / AutoLink
 * - MCP 发现与按 ID 读取均拒绝
 * - 人类 Web 列表 / 编辑 / FTS 搜索仍可用
 *
 * 纯查询判定在 aiExcludeQuery.ts（无副作用，供 indexer / autoLink / aiRuntime
 * 静态引用以断开循环依赖）；本文件只保留写 / purge / reindex 等副作用，
 * 并 re-export 查询函数以保持既有 import 路径可用。
 */

import { type BlockRow } from '@notefast/core'
import { getDb } from '../db'
import { deleteVector, indexBlock } from './indexer'
import { loadDocBlockIds } from './aiExcludeQuery'

export {
  isDocRowAiExcluded,
  isDocAiExcluded,
  isBlockAiExcluded,
  loadAiExcludedDocIds,
  loadDocBlockIds,
  readDocAiExclude,
} from './aiExcludeQuery'

/**
 * 关闭 ai_exclude 后重 build 该文档下所有 block 的向量。
 * 增量语义：content 为空或仍被排除的块不重建。
 */
export async function reindexDocTree(docId: string): Promise<{ reindexed: number; errors: number }> {
  const ids = loadDocBlockIds(docId)
  let reindexed = 0
  let errors = 0
  for (const id of ids) {
    try {
      await indexBlock(id)
      reindexed++
    } catch {
      errors++
    }
  }
  return { reindexed, errors }
}

/** 写入 ai_exclude 到 blocks 显式列，返回更新后的 row */
export function writeDocAiExclude(docId: string, aiExclude: boolean): BlockRow | null {
  const db = getDb()
  const docRow = db
    .query("SELECT * FROM blocks WHERE id = ? AND type = 'document'")
    .get(docId) as BlockRow | undefined
  if (!docRow) return null

  db.query(
    "UPDATE blocks SET ai_exclude = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(aiExclude ? 1 : 0, docId)

  return db.query('SELECT * FROM blocks WHERE id = ?').get(docId) as BlockRow
}

/**
 * 开启排除后清理 AI 产物：该文档下所有块的向量 + AutoLink 建议。
 */
export async function purgeAiArtifactsForDoc(docId: string): Promise<{ vectors: number; suggestions: number }> {
  const blockIds = loadDocBlockIds(docId)

  let vectors = 0
  for (const id of blockIds) {
    try {
      await deleteVector(id)
      vectors++
    } catch {
      // 向量存储未初始化时忽略
    }
  }

  // AutoLink suggestions：按源块或候选目标所属文档清理
  const ids = blockIds
  const placeholders = ids.map(() => '?').join(',')
  let suggestions = 0
  if (ids.length > 0) {
    const delSource = getDb()
      .query(`DELETE FROM autolink_suggestions WHERE source_block_id IN (${placeholders})`)
      .run(...ids)
    suggestions += Number(delSource.changes ?? 0)
  }
  // 候选里指向该文档的建议（candidates JSON 存 camelCase docId）
  const delCand = getDb()
    .query(`DELETE FROM autolink_suggestions WHERE candidates LIKE ?`)
    .run(`%"docId":"${docId}"%`)
  suggestions += Number(delCand.changes ?? 0)

  return { vectors, suggestions }
}

/**
 * 应用 ai_exclude 切换的副作用（在 properties 写入之后调用）。
 * - 关闭 → 启用：purge 所有 AI 产物
 * - 启用 → 关闭：重新 build 向量（AutoLink 在下一次 run 时自然重建）
 * - 无变化：返回 undefined
 */
export interface AiExcludeChangeResult {
  vectors?: number
  suggestions?: number
  reindexed?: number
  errors?: number
}

export async function applyAiExcludeChange(
  docId: string,
  oldExcluded: boolean,
  newExcluded: boolean,
): Promise<AiExcludeChangeResult | undefined> {
  if (oldExcluded === newExcluded) return undefined
  if (newExcluded) {
    return await purgeAiArtifactsForDoc(docId)
  }
  const { reindexed, errors } = await reindexDocTree(docId)
  return { reindexed, errors }
}
