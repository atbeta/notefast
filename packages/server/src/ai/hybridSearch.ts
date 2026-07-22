/**
 * Hybrid Search
 *
 * 把 FTS5 关键词召回、Embedding 语义召回两条路线并行跑，
 * 用 RRF（Reciprocal Rank Fusion）合并去重；
 * 若 runtime 配置了 reranker，再对融合后的 topM 做交叉精排。
 *
 * 设计原则：
 * - 每条路线都可单独关闭：FTS5 总是可用；语义召回需要 embedding；rerank 需要 reranker
 * - 任何一层失败都不让整个流程崩——降级到下一层
 * - 返回统一的 Citation 对象，方便前端展示和 prompt 拼装
 */

import { getDb } from '../db'
import { buildFtsQuery, highlightSnippet } from '@notefast/core'
import { semanticSearch } from './indexer'
import { getRuntime, hasRuntime } from '../services/aiRuntime'
import { loadAiExcludedDocIds } from './aiExclude'

export interface SearchOptions {
  query: string
  notebookId?: string
  /** FTS5 召回上限 */
  ftsLimit?: number
  /** 语义召回上限 */
  semanticLimit?: number
  /** 融合后再返回给上层（prompt / UI）的最大数量 */
  topK?: number
  /** reranker 精排窗口（仅在 hasReranker 时生效） */
  rerankWindow?: number
  /** 当前文档 hint：同 doc 的 block 优先级 +0.05 */
  contextDocId?: string
  /**
   * 引用相关性最低分（按最终 score 过滤，默认 0 = 不过滤）。
   * 注意 score 有两种 scale：未配 reranker 时是 RRF 融合分（~0.016-0.033），
   * 配了 reranker 时是归一分（0.5-1）——阈值要按实际 scale 设置。
   * 被过滤掉的数量会计入 retrieval.discarded_low_score。
   */
  minScore?: number
  /**
   * 时间窗口下界（ISO 字符串）。仅返回 blocks.updated_at >= since 的块。
   * 留空表示无下限。常用于「我上周写过什么」「近期关于 X 的笔记」。
   */
  since?: string
  /**
   * 时间窗口上界（ISO 字符串）。仅返回 blocks.updated_at <= until 的块。
   * 留空表示无上限。
   */
  until?: string
}

export interface Citation {
  block_id: string
  doc_id: string
  doc_title: string
  /** block 类型（heading/paragraph/code...） */
  type: string
  /** 用于 prompt 的截短内容 */
  content: string
  /** 用于 UI 的高亮片段 */
  snippet: string
  /** RRF 或 rerank 后的最终分（越大越好） */
  score: number
}

export interface HybridSearchReport {
  citations: Citation[]
  retrieval: {
    fts_hits: number
    semantic_hits: number
    reranked: boolean
    model?: string
    /** 被 minScore 门槛过滤掉的引用数（0 = 没有过滤） */
    discarded_low_score?: number
  }
}

const DEFAULT_FTS_LIMIT = 20
const DEFAULT_SEMANTIC_LIMIT = 20
const DEFAULT_TOP_K = 5
const DEFAULT_RERANK_WINDOW = 20
const MAX_CITATION_CONTENT = 1200
const RRF_K = 60
const CONTEXT_DOC_BOOST = 0.05

/**
 * 语义召回的 cosine 下限（默认 0.3，可用 SEMANTIC_MIN_COSINE 覆盖）：
 * 短查询（「你好」「嗯」）会让向量库召回一堆低分命中，低于此值的直接不进融合，
 * 从源头切断 RAG 引用噪声，而不是等上层 topK 硬塞。
 */
const DEFAULT_SEMANTIC_MIN_COSINE = 0.3

function semanticMinCosine(): number {
  const raw = parseFloat(process.env.SEMANTIC_MIN_COSINE ?? '')
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_SEMANTIC_MIN_COSINE
}

/**
 * 公开入口：返回精排后的 citations。
 * 当只有 FTS5 可用、embedding 未配置时，自动降级为纯 FTS5。
 */
export async function hybridSearch(opts: SearchOptions): Promise<HybridSearchReport> {
  const start = Date.now()
  const ftsLimit = opts.ftsLimit ?? DEFAULT_FTS_LIMIT
  const semanticLimit = opts.semanticLimit ?? DEFAULT_SEMANTIC_LIMIT
  const topK = opts.topK ?? DEFAULT_TOP_K
  const rerankWindow = opts.rerankWindow ?? DEFAULT_RERANK_WINDOW

  const ftsPromise = (async () => {
    try {
      return runFts(opts.query, opts.notebookId, ftsLimit, opts.since, opts.until)
    } catch (e) {
      console.error('[hybridSearch] FTS failed:', e)
      return [] as FtsHit[]
    }
  })()
  const semanticPromise = runSemantic(opts.query, opts.notebookId, semanticLimit, opts.since, opts.until)

  const [ftsRaw0, semanticRaw0] = await Promise.all([
    ftsPromise,
    semanticPromise.catch((e) => {
      console.error('[hybridSearch] semantic failed:', e)
      return [] as SemanticRawHit[]
    }),
  ])

  // AI 软隔离：过滤 ai_exclude 文档
  const excluded = loadAiExcludedDocIds([
    ...ftsRaw0.map((h) => h.doc_id),
    ...semanticRaw0.map((h) => h.doc_id),
  ])
  const ftsRaw = ftsRaw0.filter((h) => !excluded.has(h.doc_id))
  const semanticRaw = semanticRaw0.filter((h) => !excluded.has(h.doc_id))

  const fused = rrfMerge(ftsRaw, semanticRaw)
  const rerankCandidates = fused.slice(0, rerankWindow)
  const reranked = await maybeRerank(opts.query, rerankCandidates)
  const ranked = reranked ?? rerankCandidates

  let citations = ranked.slice(0, topK).map((c) => toCitation(c, opts.query))
  citations = applyContextBoost(citations, opts.contextDocId)

  // minScore 相关性门槛：低分引用直接丢弃，避免「强制 topK」造成的引用噪声
  const minScore = opts.minScore ?? 0
  let discardedLowScore = 0
  if (minScore > 0) {
    const before = citations.length
    citations = citations.filter((c) => c.score >= minScore)
    discardedLowScore = before - citations.length
  }

  console.info(JSON.stringify({
    event: 'retrieval',
    fts_hits: ftsRaw.length,
    semantic_hits: semanticRaw.length,
    reranked: Boolean(reranked),
    returned: citations.length,
    discarded_low_score: discardedLowScore,
    duration_ms: Date.now() - start,
  }))

  return {
    citations,
    retrieval: {
      fts_hits: ftsRaw.length,
      semantic_hits: semanticRaw.length,
      reranked: Boolean(reranked),
      model: reranked ? getRuntime().rerankerConfig()?.model : undefined,
      discarded_low_score: discardedLowScore,
    },
  }
}

// ───────────────────── 子通路 ─────────────────────

interface FtsHit {
  block_id: string
  doc_id: string
  doc_title: string
  type: string
  content: string
  rank: number
  /** 在 fts 列表中的位置（用于 RRF） */
  rrf_rank?: number
}

interface SemanticRawHit {
  block_id: string
  score: number
  content: string
  doc_id: string
  doc_title: string
  rrf_rank?: number
  /** 内部字段：rerank 排序用的归一化文本 */
  rerank_text?: string
}

function runFts(
  query: string,
  notebookId: string | undefined,
  limit: number,
  since?: string,
  until?: string,
): FtsHit[] {
  if (!query.trim()) return []
  const db = getDb()
  const { query: ftsQuery } = buildFtsQuery(query, limit)
  let sql = `
    SELECT b.id as block_id, b.content as content, b.type as type, b.root_id as doc_id,
           (SELECT content FROM blocks WHERE id = b.root_id) as doc_title,
           rank
    FROM blocks_fts f
    JOIN blocks b ON b.id = f.id
    WHERE blocks_fts MATCH ?`
  const params: (string | number)[] = [ftsQuery]
  if (notebookId) {
    sql += ' AND b.notebook_id = ?'
    params.push(notebookId)
  }
  if (since) {
    sql += ' AND b.updated_at >= ?'
    params.push(since)
  }
  if (until) {
    sql += ' AND b.updated_at <= ?'
    params.push(until)
  }
  sql += ' ORDER BY rank LIMIT ?'
  params.push(limit)
  const rows = db.query(sql).all(...params as [string, ...(string | number)[]]) as Array<FtsHit & { rank: number }>
  return rows.map((r, i) => ({ ...r, rrf_rank: i + 1 }))
}

async function runSemantic(
  query: string,
  notebookId: string | undefined,
  limit: number,
  since?: string,
  until?: string,
): Promise<SemanticRawHit[]> {
  if (!query.trim()) return []
  if (!hasRuntime() || !getRuntime().hasEmbedding()) return []
  const r = getRuntime()
  const vec = await r.embedQuery(query)
  if (!vec) return []
  const minCosine = semanticMinCosine()
  const hits = (await semanticSearch(vec, limit, notebookId, since, until))
    .filter((h) => h.score >= minCosine)
  return hits.map((h, i) => ({
    block_id: h.block_id,
    score: h.score,
    content: h.content,
    doc_id: h.doc_id,
    doc_title: h.doc_title,
    rrf_rank: i + 1,
    rerank_text: snippet(h.content, 600),
  }))
}

// ───────────────────── RRF 融合 ─────────────────────

interface FusedCandidate {
  block_id: string
  doc_id: string
  doc_title: string
  type: string
  content: string
  /** RRF 累加得分 */
  score: number
  /** rerank 用的归一化文本 */
  rerank_text: string
}

function rrfMerge(fts: FtsHit[], semantic: SemanticRawHit[]): FusedCandidate[] {
  const map = new Map<string, FusedCandidate>()

  for (const f of fts) {
    if (!f.rrf_rank) continue
    const rrf = 1 / (RRF_K + f.rrf_rank)
    map.set(f.block_id, {
      block_id: f.block_id,
      doc_id: f.doc_id,
      doc_title: f.doc_title,
      type: f.type,
      content: f.content,
      score: rrf,
      rerank_text: snippet(f.content, 600),
    })
  }
  for (const s of semantic) {
    if (!s.rrf_rank) continue
    const rrf = 1 / (RRF_K + s.rrf_rank)
    const existing = map.get(s.block_id)
    if (existing) {
      existing.score += rrf
    } else {
      map.set(s.block_id, {
        block_id: s.block_id,
        doc_id: s.doc_id,
        doc_title: s.doc_title,
        type: '',
        content: s.content,
        score: rrf,
        rerank_text: s.rerank_text ?? snippet(s.content, 600),
      })
    }
  }
  // 排序后返回
  return Array.from(map.values()).sort((a, b) => b.score - a.score)
}

// ───────────────────── Rerank（可选）─────────────────────

async function maybeRerank(query: string, candidates: FusedCandidate[]): Promise<FusedCandidate[] | null> {
  if (candidates.length === 0) return null
  if (!hasRuntime() || !getRuntime().hasReranker()) return null
  const texts = candidates.map((c) => c.rerank_text)
  try {
    const hits = await getRuntime().rerank({ query, texts, topN: candidates.length })
    // 按 rerank 分数重排
    const ranked = hits
      .map((h) => ({ c: candidates[h.index], s: h.score }))
      .filter((x) => Boolean(x.c))
      .sort((a, b) => b.s - a.s)
    // 把 rerank 分数归一化到 [0,1] 作为最终 score
    const max = ranked[0]?.s ?? 1
    const min = ranked[ranked.length - 1]?.s ?? 0
    const range = max - min || 1
    return ranked.map(({ c, s }) => ({
      ...c,
      score: 0.5 + ((s - min) / range) * 0.5, // 归一到 [0.5, 1]
    }))
  } catch (e) {
    console.error('[hybridSearch] rerank failed, fallback to RRF:', e)
    return null
  }
}

// ───────────────────── 工具 ─────────────────────

function snippet(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

function toCitation(c: FusedCandidate, query: string): Citation {
  return {
    block_id: c.block_id,
    doc_id: c.doc_id,
    doc_title: c.doc_title,
    type: c.type,
    content: snippet(c.content, MAX_CITATION_CONTENT),
    snippet: highlightSnippet(c.content, query),
    score: Math.round(c.score * 10000) / 10000,
  }
}

function applyContextBoost(citations: Citation[], contextDocId?: string): Citation[] {
  if (!contextDocId) return citations
  return citations
    .map((c) => (c.doc_id === contextDocId ? { ...c, score: c.score + CONTEXT_DOC_BOOST } : c))
    .sort((a, b) => b.score - a.score)
}

/** 拉取给定 block 的相邻兄弟 + 直系父，扩展上下文以便 prompt 拼装更连贯 */
export function expandBlockContext(blockIds: string[]): Map<string, { doc_title: string; parent: string | null; neighbors: string }> {
  const out = new Map<string, { doc_title: string; parent: string | null; neighbors: string }>()
  if (blockIds.length === 0) return out
  const db = getDb()
  const placeholders = blockIds.map(() => '?').join(',')
  const rows = db
    .query(
      `SELECT b.id, b.content, b.parent_id, b.root_id,
              (SELECT content FROM blocks WHERE id = b.root_id) as doc_title
       FROM blocks b
       WHERE b.id IN (${placeholders})`,
    )
    .all(...blockIds) as Array<{ id: string; content: string; parent_id: string | null; root_id: string; doc_title: string }>

  for (const row of rows) {
    let parentContent: string | null = null
    let neighbors = ''
    if (row.parent_id) {
      const parent = db
        .query('SELECT content FROM blocks WHERE id = ?')
        .get(row.parent_id) as { content: string } | undefined
      parentContent = parent?.content ?? null
      const sibRows = db
        .query('SELECT content FROM blocks WHERE parent_id = ? ORDER BY sort ASC LIMIT 3')
        .all(row.parent_id) as Array<{ content: string }>
      neighbors = sibRows.map((s) => s.content.slice(0, 80)).join(' / ')
    }
    out.set(row.id, {
      doc_title: row.doc_title,
      parent: parentContent,
      neighbors,
    })
  }
  return out
}
