/**
 * 文档语义邻居 — 右栏「相关」数据源
 *
 * 优先用锚点块已入库向量做近邻（不再 embed query）。
 * 写作时锚点是当前块；阅读整篇、未点选块时用文档根。
 * 锚点还没有向量时回退词法，保证未配嵌入的库仍能出结果。
 */

import { readTags, type BlockRow } from '@notefast/core'
import { hybridSearch } from '../ai/hybridSearch'
import {
  loadAiExcludedDocIds,
  loadArchivedDocIds,
  loadInboxDocIds,
} from '../ai/aiExcludeQuery'
import { getVectorStore } from '../ai/vectorStore'
import { getDb } from '../db'
import { fetchDocBlocks, getDocById, getLiveBlockById } from '../store/blocks'

export interface RelatedDocItem {
  doc_id: string
  title: string
  snippet: string
  score: number
}

const BODY_FALLBACK_CHARS = 200
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20

/** 从文档根构造邻居检索 query（仅 FTS 回退用） */
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

function ftsQueryForAnchor(docRow: BlockRow, anchor: BlockRow): string {
  if (anchor.id === docRow.id || anchor.type === 'document') {
    return buildRelatedQuery(docRow, firstBodySnippet(docRow.id))
  }
  const text = (anchor.content || '').replace(/\s+/g, ' ').trim().slice(0, BODY_FALLBACK_CHARS)
  return text
}

/** 指定块属于本文且未删除时用之，否则退回文档根 */
export function resolveRelatedAnchor(docRow: BlockRow, blockId?: string): BlockRow {
  if (!blockId || blockId === docRow.id) return docRow
  const row = getLiveBlockById(getDb(), blockId)
  if (!row || row.root_id !== docRow.id) return docRow
  return row
}

/** 优先锚点自身向量，再沿 parent 上溯，最后扫本文其它已索引块 */
async function getAnchorVector(docId: string, anchor: BlockRow): Promise<Float64Array | null> {
  const store = getVectorStore()
  const db = getDb()
  const seen = new Set<string>()
  let current: BlockRow | null = anchor
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const vec = await store.getStoredVector(current.id)
    if (vec && vec.length > 0) return vec
    if (!current.parent_id) break
    current = getLiveBlockById(db, current.parent_id)
  }
  const blocks = fetchDocBlocks(db, docId)
  for (const b of blocks) {
    if (seen.has(b.id)) continue
    if (!(b.content || '').trim()) continue
    const vec = await store.getStoredVector(b.id)
    if (vec && vec.length > 0) return vec
  }
  return null
}

function toItems(
  docId: string,
  limit: number,
  hits: Array<{ doc_id: string; doc_title: string; content: string; score: number }>,
): RelatedDocItem[] {
  const docIds = hits.map((h) => h.doc_id)
  const excluded = loadAiExcludedDocIds(docIds)
  const inbox = loadInboxDocIds(docIds)
  const archived = loadArchivedDocIds(docIds)
  const items: RelatedDocItem[] = []
  const seen = new Set<string>()
  for (const h of hits) {
    if (h.doc_id === docId) continue
    if (seen.has(h.doc_id)) continue
    if (excluded.has(h.doc_id) || inbox.has(h.doc_id) || archived.has(h.doc_id)) continue
    seen.add(h.doc_id)
    items.push({
      doc_id: h.doc_id,
      title: h.doc_title || '',
      snippet: h.content || '',
      score: h.score,
    })
    if (items.length >= limit) break
  }
  return items
}

/** 已入库向量的 KNN；搜不到或索引不可用返回 null，由调用方回退 FTS */
async function listRelatedByVector(
  docId: string,
  anchor: BlockRow,
  limit: number,
): Promise<RelatedDocItem[] | null> {
  const store = getVectorStore()
  const status = await store.status()
  if (!status.modelFingerprint) return null
  const query = await getAnchorVector(docId, anchor)
  if (!query) return null
  if (status.dimension && query.length !== status.dimension) return null

  const raw = await store.search(query, {
    limit: Math.min(MAX_LIMIT, limit + 16) * 3,
    modelFingerprint: status.modelFingerprint,
  })
  if (raw.length === 0) return null
  return toItems(docId, limit, raw)
}

async function listRelatedByFts(
  docId: string,
  docRow: BlockRow,
  anchor: BlockRow,
  limit: number,
): Promise<RelatedDocItem[]> {
  const query = ftsQueryForAnchor(docRow, anchor)
  if (!query) return []

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

  return toItems(
    docId,
    limit,
    report.citations.map((c) => ({
      doc_id: c.doc_id,
      doc_title: c.doc_title || '',
      content: c.snippet || c.content || '',
      score: c.score,
    })),
  )
}

/**
 * 查找与锚点块（缺省为文档根）相关的其它文档。
 * 文档不存在返回 null；优先向量距离，无向量再词法。
 */
export async function listRelatedDocs(
  docId: string,
  opts?: { limit?: number; blockId?: string },
): Promise<{ items: RelatedDocItem[] } | null> {
  const db = getDb()
  const docRow = getDocById(db, docId)
  if (!docRow) return null

  const limitRaw = opts?.limit ?? DEFAULT_LIMIT
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT))
  const anchor = resolveRelatedAnchor(docRow, opts?.blockId)

  const vectorItems = await listRelatedByVector(docId, anchor, limit)
  if (vectorItems) return { items: vectorItems }

  return { items: await listRelatedByFts(docId, docRow, anchor, limit) }
}
