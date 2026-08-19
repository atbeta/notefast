/**
 * 文档语义邻居 — 右栏「相关」数据源
 *
 * 用标题 + tags（缺标题则截正文）作 query，走 hybridSearch（contextDocId 开图谱路），
 * maxPerDoc=1 后排除自身，聚合成文档级列表。不新建向量算法。
 */

import { readTags, type BlockRow } from '@notefast/core'
import { hybridSearch } from '../ai/hybridSearch'
import { getDb } from '../db'
import { fetchDocBlocks, getDocById } from '../store/blocks'

export interface RelatedDocItem {
  doc_id: string
  title: string
  snippet: string
  score: number
}

const BODY_FALLBACK_CHARS = 200
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20

/** 从文档根构造邻居检索 query */
export function buildRelatedQuery(docRow: BlockRow, bodyFallback?: string): string {
  const title = (docRow.content || '').trim()
  const tags = readTags(docRow)
  const parts: string[] = []
  if (title) parts.push(title)
  if (tags.length > 0) parts.push(tags.join(' '))
  if (parts.length === 0 && bodyFallback) {
    const clipped = bodyFallback.replace(/\s+/g, ' ').trim().slice(0, BODY_FALLBACK_CHARS)
    if (clipped) parts.push(clipped)
  }
  return parts.join(' ').trim()
}

function firstBodySnippet(docId: string): string {
  const rows = fetchDocBlocks(getDb(), docId)
  for (const r of rows) {
    if (r.id === docId) continue
    const t = (r.content || '').trim()
    if (t) return t
  }
  return ''
}

/**
 * 查找与文档语义/词法/图谱相关的其它文档。
 * 文档不存在返回 null；query 为空返回空列表。
 */
export async function listRelatedDocs(
  docId: string,
  opts?: { limit?: number },
): Promise<{ items: RelatedDocItem[] } | null> {
  const db = getDb()
  const docRow = getDocById(db, docId)
  if (!docRow) return null

  const limitRaw = opts?.limit ?? DEFAULT_LIMIT
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT))

  const query = buildRelatedQuery(docRow, firstBodySnippet(docId))
  if (!query) return { items: [] }

  // 轻量路径：跳过 embed + rerank + 实体 + 图谱上下文。
  // 右栏「相关」的目标是「找到相关文档」，不要「与当前文档的关系网」——
  // 实体通道（LIKE+子查询）和图谱上下文（自身/互链/共享实体三段 SQL + ROW_NUMBER）
  // 对这个目标边际收益小、且 KB 大时显著拖慢，砍掉。只走 FTS 词法 + 标题两路。
  const report = await hybridSearch({
    query,
    contextDocId: docId,
    topK: Math.min(MAX_LIMIT, limit + 4),
    ftsLimit: 24,
    maxPerDoc: 1,
    understandQuery: false,
    skipSemantic: true,
    skipRerank: true,
    skipEntity: true,
    skipGraphContext: true,
  })

  const items: RelatedDocItem[] = []
  const seen = new Set<string>()
  for (const c of report.citations) {
    if (c.doc_id === docId) continue
    if (seen.has(c.doc_id)) continue
    seen.add(c.doc_id)
    items.push({
      doc_id: c.doc_id,
      title: c.doc_title || '',
      snippet: c.snippet || c.content || '',
      score: c.score,
    })
    if (items.length >= limit) break
  }
  return { items }
}
