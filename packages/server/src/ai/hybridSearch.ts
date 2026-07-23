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
 * - 分阶段 timing（fts / embed_query / semantic / rerank / total）可量化 Fast
 */

import { getDb } from '../db'
import { runFtsQuery } from '../dbQueries'
import { buildFtsQuery, highlightSnippet } from '@notefast/core'
import { semanticSearch } from './indexer'
import { getRuntime, hasRuntime } from '../services/aiRuntime'
import { loadAiExcludedDocIds, loadInboxDocIds } from './aiExcludeQuery'

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
  /**
   * 是否包含收集箱文档（默认 false：RAG 与主列表一致，排除 inbox）。
   */
  includeInbox?: boolean
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

/** 检索各阶段耗时（毫秒）；未跑的阶段为 0 */
export interface RetrievalTiming {
  fts_ms: number
  embed_query_ms: number
  semantic_ms: number
  rerank_ms: number
  total_ms: number
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
    /** 分阶段耗时（NoteFast：可量化） */
    timing: RetrievalTiming
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
  const includeInbox = opts.includeInbox === true

  const ftsPromise = (async (): Promise<{ hits: FtsHit[]; fts_ms: number }> => {
    const t0 = Date.now()
    try {
      const hits = runFts(opts.query, opts.notebookId, ftsLimit, opts.since, opts.until)
      return { hits, fts_ms: Date.now() - t0 }
    } catch (e) {
      console.error('[hybridSearch] FTS failed:', e)
      return { hits: [], fts_ms: Date.now() - t0 }
    }
  })()

  const semanticPromise = runSemantic(opts.query, opts.notebookId, semanticLimit, opts.since, opts.until)

  const [ftsResult, semanticResult] = await Promise.all([
    ftsPromise,
    semanticPromise.catch((e) => {
      console.error('[hybridSearch] semantic failed:', e)
      return { hits: [] as SemanticRawHit[], embed_query_ms: 0, semantic_ms: 0 }
    }),
  ])

  const ftsRaw0 = ftsResult.hits
  const semanticRaw0 = semanticResult.hits

  // AI 软隔离 + 收集箱：过滤 ai_exclude；默认也过滤 inbox
  const excluded = loadAiExcludedDocIds([
    ...ftsRaw0.map((h) => h.doc_id),
    ...semanticRaw0.map((h) => h.doc_id),
  ])
  const inboxIds = includeInbox
    ? new Set<string>()
    : loadInboxDocIds([
        ...ftsRaw0.map((h) => h.doc_id),
        ...semanticRaw0.map((h) => h.doc_id),
      ])
  const drop = (docId: string) => excluded.has(docId) || inboxIds.has(docId)
  const ftsRaw = ftsRaw0.filter((h) => !drop(h.doc_id))
  const semanticRaw = semanticRaw0.filter((h) => !drop(h.doc_id))

  const fused = rrfMerge(ftsRaw, semanticRaw)
  const rerankCandidates = fused.slice(0, rerankWindow)
  const rerankT0 = Date.now()
  const reranked = await maybeRerank(opts.query, rerankCandidates)
  const rerank_ms = reranked ? Date.now() - rerankT0 : 0
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

  const timing: RetrievalTiming = {
    fts_ms: ftsResult.fts_ms,
    embed_query_ms: semanticResult.embed_query_ms,
    semantic_ms: semanticResult.semantic_ms,
    rerank_ms,
    total_ms: Date.now() - start,
  }

  console.info(JSON.stringify({
    event: 'retrieval',
    fts_hits: ftsRaw.length,
    semantic_hits: semanticRaw.length,
    reranked: Boolean(reranked),
    returned: citations.length,
    discarded_low_score: discardedLowScore,
    ...timing,
    duration_ms: timing.total_ms,
  }))

  return {
    citations,
    retrieval: {
      fts_hits: ftsRaw.length,
      semantic_hits: semanticRaw.length,
      reranked: Boolean(reranked),
      model: reranked ? getRuntime().rerankerConfig()?.model : undefined,
      discarded_low_score: discardedLowScore,
      timing,
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
  // ai_exclude / inbox 不过取：在 hybridSearch 融合层与语义召回一起过滤
  const rows = runFtsQuery<FtsHit>(db, {
    match: ftsQuery,
    notebookId,
    since,
    until,
    limit,
    select: `b.id as block_id, b.content as content, b.type as type, b.root_id as doc_id,
           (SELECT content FROM blocks WHERE id = b.root_id) as doc_title,
           rank`,
  })
  return rows.map((r, i) => ({ ...r, rrf_rank: i + 1 }))
}

async function runSemantic(
  query: string,
  notebookId: string | undefined,
  limit: number,
  since?: string,
  until?: string,
): Promise<{ hits: SemanticRawHit[]; embed_query_ms: number; semantic_ms: number }> {
  if (!query.trim()) return { hits: [], embed_query_ms: 0, semantic_ms: 0 }
  if (!hasRuntime() || !getRuntime().hasEmbedding()) {
    return { hits: [], embed_query_ms: 0, semantic_ms: 0 }
  }
  const r = getRuntime()
  const embedT0 = Date.now()
  const vec = await r.embedQuery(query)
  const embed_query_ms = Date.now() - embedT0
  if (!vec) return { hits: [], embed_query_ms, semantic_ms: 0 }

  const searchT0 = Date.now()
  const minCosine = semanticMinCosine()
  const hits = (await semanticSearch(vec, limit, notebookId, since, until))
    .filter((h) => h.score >= minCosine)
  const semantic_ms = Date.now() - searchT0

  return {
    embed_query_ms,
    semantic_ms,
    hits: hits.map((h, i) => ({
      block_id: h.block_id,
      score: h.score,
      content: h.content,
      doc_id: h.doc_id,
      doc_title: h.doc_title,
      rrf_rank: i + 1,
      rerank_text: snippet(h.content, 600),
    })),
  }
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
