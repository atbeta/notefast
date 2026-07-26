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
import { deleteVector } from './indexer'
import { scheduleDocIndex, type IndexJob } from './indexJobs'
import { loadDocBlockIds } from './aiExcludeQuery'

export {
  isDocRowAiExcluded,
  isDocAiExcluded,
  isBlockAiExcluded,
  loadAiExcludedDocIds,
  loadDocBlockIds,
  readDocAiExclude,
} from './aiExcludeQuery'

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
 * - 关闭 → 启用：purge 所有 AI 产物（本地删除，快）
 * - 启用 → 关闭：调度文档级索引作业异步重建向量（批量 embed + 进度/ETA），
 *   不在请求内逐块 await embedding API —— N 块 × 网络延迟会把接口卡到分钟级；
 *   embedding / autoIndex 未启用时不重建（返回 { reindexed: 0 }）
 * - 无变化：返回 undefined
 */
export interface AiExcludeChangeResult {
  vectors?: number
  suggestions?: number
  reindexed?: number
  errors?: number
  /** 恢复可见时调度的索引作业（前端可轮询进度） */
  index_job?: IndexJob
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
  const job = scheduleDocIndex(docId, loadDocBlockIds(docId))
  return job ? { index_job: job } : { reindexed: 0, errors: 0 }
}
