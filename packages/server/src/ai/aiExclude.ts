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
import { getBlockById, getDocById, updateBlock } from '../store/blocks'
import { deleteMentionsTouchingBlocks } from '../store/entities'
import { deleteVector } from './indexer'
import { scheduleDocIndex, type IndexJob } from './indexJobs'
import { loadDocBlockIds } from './aiExcludeQuery'
import { reanalyzeDoc } from './autoLink'

export {
  isDocRowAiExcluded,
  isDocAiExcluded,
  isBlockAiExcluded,
  loadAiExcludedDocIds,
  loadDocBlockIds,
  readDocAiExclude,
} from './aiExcludeQuery'

/** 统计一批 block 当前的实体提及数（purge 返回计数用） */
function countMentionsOfBlocks(db: ReturnType<typeof getDb>, blockIds: string[]): number {
  if (blockIds.length === 0) return 0
  const placeholders = blockIds.map(() => '?').join(',')
  const row = db
    .query(`SELECT count(*) AS c FROM entity_mentions WHERE block_id IN (${placeholders})`)
    .get(...(blockIds as [string, ...string[]])) as { c: number }
  return row.c
}

/** 写入 ai_exclude 到 blocks 显式列，返回更新后的 row */
export function writeDocAiExclude(docId: string, aiExclude: boolean): BlockRow | null {
  const db = getDb()
  const docRow = getDocById(db, docId)
  if (!docRow) return null

  updateBlock(db, docId, { ai_exclude: aiExclude ? 1 : 0, touchUpdatedAt: false })

  return getBlockById(db, docId)
}

/**
 * 开启排除后清理 AI 产物：该文档下所有块的向量与实体提及。
 * （实体进检索召回路，必须物理清理——不同于 ai_auto refs 的「自然收敛」：
 * 该文档块发出的 ai_auto 引用由块删除级联或下次内容更新重评自然收敛，无需在此清理。）
 */
export async function purgeAiArtifactsForDoc(docId: string): Promise<{ vectors: number; mentions: number }> {
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

  const mentionsBefore = countMentionsOfBlocks(getDb(), blockIds)
  deleteMentionsTouchingBlocks(getDb(), blockIds)

  return { vectors, mentions: mentionsBefore }
}

/**
 * 应用 ai_exclude 切换的副作用（在 properties 写入之后调用）。
 * - 关闭 → 启用：purge 所有 AI 产物（向量 + 实体提及；本地删除，快）
 * - 启用 → 关闭：调度文档级索引作业异步重建向量（批量 embed + 进度/ETA），
 *   不在请求内逐块 await embedding API —— N 块 × 网络延迟会把接口卡到分钟级；
 *   embedding / autoIndex 未启用时不重建（返回 { reindexed: 0 }）；
 *   同时全 doc 重抽补齐实体与链（reanalyzeDoc，fire-and-forget）
 * - 无变化：返回 undefined
 */
export interface AiExcludeChangeResult {
  vectors?: number
  /** purge 时清理的实体提及数 */
  mentions?: number
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
  // 恢复可见 = 重新进入流通：全 doc 重抽补齐实体与链（fire-and-forget，限速自然生效）
  reanalyzeDoc(docId)
  return job ? { index_job: job } : { reindexed: 0, errors: 0 }
}
