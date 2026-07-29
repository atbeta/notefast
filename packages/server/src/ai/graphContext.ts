/**
 * 图谱上下文通道 —— hybridSearch 的第五路 RRF 输入
 *
 * 把「与当前正在阅读的文档的关系」做成一路 RRF 输入列表：RRF 每路一票的语义
 * 尺度天然一致（取代旧的 applyContextBoost 绝对加分），且影响发生在截断与
 * rerank 之前。三段拼装，列表顺序即 RRF 票序：
 *
 * 1. 当前文档自身 blocks（最近更新序，cap 5）——「优先我正在看的笔记」
 * 2. 直接互链文档的 blocks（block_refs 双向，每 doc cap 2，总 cap 10）
 * 3. 共享实体文档的 blocks（entity_mentions 反查，共享实体数倒序，每 doc 1 块，总 cap 10）
 *
 * ai_exclude / inbox / archived 过滤在 hybridSearch 融合层与其他通道统一做，本路不重复过滤。
 */

import { getDb } from '../db'

export interface GraphContextHit {
  block_id: string
  doc_id: string
  doc_title: string
  type: string
  content: string
  rrf_rank: number
}

/** 当前文档自身块数上限 */
const SELF_CAP = 5
/** 互链文档块总上限 / 每文档块数上限 */
const LINK_TOTAL_CAP = 10
const LINK_PER_DOC = 2
/** 共享实体文档块总上限（每文档 1 块） */
const ENTITY_TOTAL_CAP = 10

interface BlockRow {
  id: string
  content: string
  type: string
  root_id: string
  doc_title: string | null
}

function toHit(r: BlockRow): Omit<GraphContextHit, 'rrf_rank'> {
  return {
    block_id: r.id,
    doc_id: r.root_id,
    doc_title: r.doc_title ?? '',
    type: r.type,
    content: r.content,
  }
}

/** 文档块的通用过滤：未删除、非文档根、内容非空 */
const BLOCK_WHERE = `b.is_deleted = 0 AND b.type != 'document' AND trim(b.content) != ''`

export function graphContextCandidates(contextDocId: string): GraphContextHit[] {
  const db = getDb()
  const hits: Omit<GraphContextHit, 'rrf_rank'>[] = []
  const seenBlocks = new Set<string>()
  /** 已纳入的文档（自身 + 互链），共享实体段不再重复 */
  const seenDocs = new Set<string>([contextDocId])
  const push = (r: BlockRow) => {
    if (seenBlocks.has(r.id)) return
    seenBlocks.add(r.id)
    hits.push(toHit(r))
  }

  // 段 1：当前文档自身（最近更新序）
  const selfRows = db
    .query(
      `SELECT b.id, b.content, b.type, b.root_id, d.content AS doc_title
       FROM blocks b LEFT JOIN blocks d ON d.id = b.root_id
       WHERE b.root_id = ? AND ${BLOCK_WHERE}
       ORDER BY b.updated_at DESC LIMIT ?`,
    )
    .all(contextDocId, SELF_CAP) as BlockRow[]
  for (const r of selfRows) push(r)

  // 段 2：直接互链文档（block_refs 双向：source 属于本文档 或 target 属于本文档，取对端文档）
  // 窗口函数按 doc 截每 doc 最新 LINK_PER_DOC 块，外层按 updated_at 定 RRF 票序
  const linkedRows = db
    .query(
      `SELECT id, content, type, root_id, doc_title FROM (
         SELECT b.id, b.content, b.type, b.root_id, b.updated_at, d.content AS doc_title,
                ROW_NUMBER() OVER (PARTITION BY b.root_id ORDER BY b.updated_at DESC) AS rn
         FROM blocks b
         LEFT JOIN blocks d ON d.id = b.root_id
         WHERE b.root_id IN (
           SELECT doc_id FROM (
             SELECT t.root_id AS doc_id
             FROM block_refs r
             JOIN blocks s ON s.id = r.source_id AND s.is_deleted = 0 AND s.root_id = ?
             JOIN blocks t ON t.id = r.target_id AND t.is_deleted = 0
             UNION
             SELECT s2.root_id AS doc_id
             FROM block_refs r
             JOIN blocks t2 ON t2.id = r.target_id AND t2.is_deleted = 0 AND t2.root_id = ?
             JOIN blocks s2 ON s2.id = r.source_id AND s2.is_deleted = 0
           ) WHERE doc_id IS NOT NULL AND doc_id != ?
         ) AND ${BLOCK_WHERE}
       )
       WHERE rn <= ?
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(contextDocId, contextDocId, contextDocId, LINK_PER_DOC, LINK_TOTAL_CAP) as BlockRow[]
  for (const r of linkedRows) {
    seenDocs.add(r.root_id)
    push(r)
  }

  // 段 3：共享实体文档（本文档块提过的实体 → 这些实体的其他 mentions 所在文档）
  const entityIds = (
    db
      .query(
        `SELECT DISTINCT m.entity_id AS id
         FROM entity_mentions m
         JOIN blocks b ON b.id = m.block_id AND b.is_deleted = 0
         WHERE b.root_id = ?`,
      )
      .all(contextDocId) as Array<{ id: string }>
  ).map((r) => r.id)

  if (entityIds.length > 0) {
    const placeholders = entityIds.map(() => '?').join(',')
    const sharedDocs = db
      .query(
        `SELECT b.root_id AS doc_id, COUNT(DISTINCT m.entity_id) AS shared
         FROM entity_mentions m
         JOIN blocks b ON b.id = m.block_id AND b.is_deleted = 0
         WHERE m.entity_id IN (${placeholders})
         GROUP BY b.root_id
         ORDER BY shared DESC`,
      )
      .all(...(entityIds as [string, ...string[]])) as Array<{ doc_id: string; shared: number }>
    let taken = 0
    for (const row of sharedDocs) {
      if (taken >= ENTITY_TOTAL_CAP) break
      if (seenDocs.has(row.doc_id)) continue
      seenDocs.add(row.doc_id)
      const block = db
        .query(
          `SELECT b.id, b.content, b.type, b.root_id, d.content AS doc_title
           FROM blocks b LEFT JOIN blocks d ON d.id = b.root_id
           WHERE b.root_id = ? AND ${BLOCK_WHERE}
           ORDER BY b.updated_at DESC LIMIT 1`,
        )
        .get(row.doc_id) as BlockRow | undefined
      if (!block) continue
      taken += 1
      push(block)
    }
  }

  // 列表顺序即 RRF 票序：自身 > 互链 > 共享实体
  return hits.map((h, i) => ({ ...h, rrf_rank: i + 1 }))
}
