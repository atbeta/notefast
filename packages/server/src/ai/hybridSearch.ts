/**
 * Hybrid Search
 *
 * 五路召回并行：FTS5/LIKE 词法、Embedding 语义、标题（文档根块）、实体提及、
 * 图谱上下文（有 contextDocId 时），用 RRF（Reciprocal Rank Fusion）合并去重；
 * 若 runtime 配置了 reranker，再对融合后的 topM 做交叉精排（score 为 reranker 原始分，
 * RRF 融合分保留在 rrf_score）；精排/融合后按 maxPerDoc 做文档多样性选择再截断。
 *
 * 设计原则：
 * - 每条路线都可单独关闭：FTS5 总是可用；语义召回需要 embedding；rerank 需要 reranker
 * - 任何一层失败都不让整个流程崩——降级到下一层
 * - 返回统一的 Citation 对象，方便前端展示和 prompt 拼装
 * - 分阶段 timing（fts / embed_query / semantic / rerank / total）可量化 Fast
 */

import { highlightSnippet } from '@notefast/core'
import { lexicalSearch } from '../lexicalSearch'
import { semanticSearch } from './indexer'
import { entitySearch } from './entitySearch'
import { graphContextCandidates } from './graphContext'
import { getRuntime, hasRuntime } from '../services/aiRuntime'
import { loadAiExcludedDocIds, loadInboxDocIds, loadArchivedDocIds } from './aiExcludeQuery'

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
  /** 当前文档 hint：以其为中心构造图谱上下文通道（第 5 路 RRF 输入：自身 > 互链 > 共享实体） */
  contextDocId?: string
  /**
   * 引用相关性最低分（按最终 score 过滤，默认 0 = 不过滤）。
   * 注意 score 有两种 scale：配 reranker 时是模型原始分（bge 系经验 0.3~0.9，
   * 需按所用模型校准）；未配时是 RRF 融合分（5 路 k=60，约 0.016-0.066）。
   * 被过滤掉的数量会计入 retrieval.discarded_low_score。
   */
  minScore?: number
  /**
   * 单文档引用数上限（多样性约束，默认 2）。融合/精排后先按分每 doc 取
   * ≤maxPerDoc 条，不足 topK 时按分从溢出补齐（不因多样性少给结果）。
   */
  maxPerDoc?: number
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
  /**
   * 是否包含归档文档（默认 false：归档软排除，避免过时内容污染回答；
   * 显式查历史时置 true）。
   */
  includeArchived?: boolean
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
  /** 最终分（配 reranker 时为模型原始精排分，否则为 RRF 融合分；越大越好） */
  score: number
  /** RRF 融合分（恒定保留，诊断与跨 scale 对比用） */
  rrf_score: number
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
    /** 词法通道命中来源分布（fts / like_and / like_or，调试与评测报告用） */
    fts_matched_by?: Record<string, number>
    semantic_hits: number
    reranked: boolean
    /** score 的尺度：reranker 原始分（rerank）或 RRF 融合分（rrf） */
    score_kind: 'rerank' | 'rrf'
    model?: string
    /** 被 minScore 门槛过滤掉的引用数（0 = 没有过滤） */
    discarded_low_score?: number
    /** 分阶段耗时（NoteFast：可量化） */
    timing: RetrievalTiming
  }
}

// 词法召回上限：LIKE 路零成本扩大召回，后置过滤（ai_exclude/生命周期）会吃掉名额
const DEFAULT_FTS_LIMIT = 60
const DEFAULT_SEMANTIC_LIMIT = 20
const DEFAULT_TOP_K = 5
const DEFAULT_RERANK_WINDOW = 20
const MAX_CITATION_CONTENT = 1200
const RRF_K = 60
/** 多样性约束的默认单文档引用上限 */
const DEFAULT_MAX_PER_DOC = 2

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
  const includeArchived = opts.includeArchived === true

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

  const semanticPromise = runSemantic(opts.query, opts.notebookId, semanticLimit, opts.since, opts.until, {
    includeInbox,
    includeArchived,
  })

  const [ftsResult, semanticResult] = await Promise.all([
    ftsPromise,
    semanticPromise.catch((e) => {
      console.error('[hybridSearch] semantic failed:', e)
      return { hits: [] as SemanticRawHit[], embed_query_ms: 0, semantic_ms: 0 }
    }),
  ])

  const ftsRaw0 = ftsResult.hits
  const semanticRaw0 = semanticResult.hits

  // 标题通道：只查文档根块（type='document'），作为独立 RRF 输入列表提升标题命中。
  // 主词法路本身也会命中根块，标题通道的意义是多一份 RRF 票，把「查询词在标题里」的文档顶上来
  let titleHits0: FtsHit[] = []
  try {
    titleHits0 = lexicalSearch(opts.query, {
      notebookId: opts.notebookId,
      limit: 5,
      strictOnly: true,
      titleOnly: true,
    }).map((h, i) => ({
      block_id: h.id,
      doc_id: h.root_id,
      doc_title: h.doc_title,
      type: h.type,
      content: h.content,
      rank: -h.rank_score,
      matched_by: h.matched_by,
      rrf_rank: i + 1,
    }))
  } catch (e) {
    console.error('[hybridSearch] title channel failed:', e)
  }

  // 实体通道：query 命中实体 → 反查提及块，作为独立 RRF 输入列表。
  // 实体表为空时零成本短路；图谱越写越厚，这条路的召回随之增强
  let entityHits0: FtsHit[] = []
  try {
    entityHits0 = entitySearch(opts.query).map((h) => ({
      block_id: h.block_id,
      doc_id: h.doc_id,
      doc_title: h.doc_title,
      type: h.type,
      content: h.content,
      rank: 0,
      matched_by: 'entity',
      rrf_rank: h.rrf_rank,
    }))
  } catch (e) {
    console.error('[hybridSearch] entity channel failed:', e)
  }

  // 图谱上下文通道（第 5 路）：有 contextDocId 时以该文档为中心召回
  // 自身/互链/共享实体文档的块；失败不拖垮主流程
  let contextHits0: FtsHit[] = []
  if (opts.contextDocId) {
    try {
      contextHits0 = graphContextCandidates(opts.contextDocId).map((h) => ({
        block_id: h.block_id,
        doc_id: h.doc_id,
        doc_title: h.doc_title,
        type: h.type,
        content: h.content,
        rank: 0,
        matched_by: 'graph_context',
        rrf_rank: h.rrf_rank,
      }))
    } catch (e) {
      console.error('[hybridSearch] graph context channel failed:', e)
    }
  }

  // AI 软隔离 + 生命周期：过滤 ai_exclude；默认也过滤 inbox 与 archived
  const candidateDocIds = [
    ...ftsRaw0.map((h) => h.doc_id),
    ...semanticRaw0.map((h) => h.doc_id),
    ...titleHits0.map((h) => h.doc_id),
    ...entityHits0.map((h) => h.doc_id),
    ...contextHits0.map((h) => h.doc_id),
  ]
  const excluded = loadAiExcludedDocIds(candidateDocIds)
  const inboxIds = includeInbox ? new Set<string>() : loadInboxDocIds(candidateDocIds)
  const archivedIds = includeArchived ? new Set<string>() : loadArchivedDocIds(candidateDocIds)
  const drop = (docId: string) => excluded.has(docId) || inboxIds.has(docId) || archivedIds.has(docId)
  const ftsRaw = ftsRaw0.filter((h) => !drop(h.doc_id))
  const semanticRaw = semanticRaw0.filter((h) => !drop(h.doc_id))
  const titleRaw = titleHits0.filter((h) => !drop(h.doc_id))
  const entityRaw = entityHits0.filter((h) => !drop(h.doc_id))
  const contextRaw = contextHits0.filter((h) => !drop(h.doc_id))

  const fused = rrfMerge(ftsRaw, semanticRaw, titleRaw, entityRaw, contextRaw)
  const rerankCandidates = fused.slice(0, rerankWindow)
  const rerankT0 = Date.now()
  const reranked = await maybeRerank(opts.query, rerankCandidates)
  const rerank_ms = reranked ? Date.now() - rerankT0 : 0
  const ranked = reranked ?? rerankCandidates

  // 多样性约束：每 doc 先取 ≤maxPerDoc 条，不足 topK 再从溢出按分补齐（先选后截）
  const diversified = applyDocDiversity(ranked, opts.maxPerDoc ?? DEFAULT_MAX_PER_DOC)
  const citations0 = diversified.slice(0, topK).map((c) => toCitation(c, opts.query))

  // minScore 相关性门槛：低分引用直接丢弃，避免「强制 topK」造成的引用噪声
  const minScore = opts.minScore ?? 0
  let discardedLowScore = 0
  let citations = citations0
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
      fts_matched_by: countBy(ftsRaw.map((h) => h.matched_by ?? 'fts')),
      semantic_hits: semanticRaw.length,
      reranked: Boolean(reranked),
      score_kind: reranked ? 'rerank' : 'rrf',
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
  /** 命中来源（lexicalSearch 双路：fts / like_and / like_or / title） */
  matched_by?: string
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
  // 双路词法检索（FTS5 + LIKE）：无空格中文走 LIKE 子串召回，ASCII 沿用 FTS bm25。
  // ai_exclude / inbox 不过取：在 hybridSearch 融合层与语义召回一起过滤
  return lexicalSearch(query, { notebookId, limit, since, until }).map((h, i) => ({
    block_id: h.id,
    doc_id: h.root_id,
    doc_title: h.doc_title,
    type: h.type,
    content: h.content,
    rank: -h.rank_score, // 保持「越小越好」的 rank 惯例（原 bm25 rank 为负）
    matched_by: h.matched_by,
    rrf_rank: i + 1,
  }))
}

async function runSemantic(
  query: string,
  notebookId: string | undefined,
  limit: number,
  since?: string,
  until?: string,
  options?: { includeInbox?: boolean; includeArchived?: boolean },
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
  const hits = (await semanticSearch(vec, limit, notebookId, since, until, options))
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
      rerank_text: rerankText(h.doc_title, h.content),
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
  /** 最终分（融合时为 RRF 累加分；rerank 后被替换为 reranker 原始分） */
  score: number
  /** RRF 融合分（rerank 后仍保留，诊断与跨 scale 对比用） */
  rrf_score: number
  /** rerank 用的归一化文本 */
  rerank_text: string
}

function rrfMerge(fts: FtsHit[], semantic: SemanticRawHit[], title: FtsHit[] = [], entity: FtsHit[] = [], context: FtsHit[] = []): FusedCandidate[] {
  const map = new Map<string, Omit<FusedCandidate, 'rrf_score'>>()

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
      rerank_text: rerankText(f.doc_title, f.content),
    })
  }
  // 标题/实体/图谱上下文通道：与 fts 同构，已存在的 block_id 累加 RRF 票
  // （标题命中同时也在主 LIKE 路里；实体命中补充词法/语义都够不到的提及块；
  //   上下文通道补充「与当前文档相关」的块）
  for (const t of [...title, ...entity, ...context]) {
    if (!t.rrf_rank) continue
    const rrf = 1 / (RRF_K + t.rrf_rank)
    const existing = map.get(t.block_id)
    if (existing) {
      existing.score += rrf
    } else {
      map.set(t.block_id, {
        block_id: t.block_id,
        doc_id: t.doc_id,
        doc_title: t.doc_title,
        type: t.type,
        content: t.content,
        score: rrf,
        rerank_text: rerankText(t.doc_title, t.content),
      })
    }
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
        rerank_text: s.rerank_text ?? rerankText(s.doc_title, s.content),
      })
    }
  }
  // 排序后返回；rrf_score 记录融合分（rerank 改写 score 后仍保留）
  const merged = Array.from(map.values()).sort((a, b) => b.score - a.score)
  return merged.map((c) => ({ ...c, rrf_score: c.score }))
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
    // score = reranker 原始分（不做 min-max 归一化，保留跨批次的绝对意义供 minScore 过滤）
    return ranked.map(({ c, s }) => ({
      ...c,
      score: s,
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

/** 命中来源分布统计（report.fts_matched_by） */
function countBy(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of keys) out[k] = (out[k] ?? 0) + 1
  return out
}

/** reranker 输入：文档标题前缀 + 截短正文（标题为空时退化为正文） */
function rerankText(docTitle: string, content: string): string {
  const body = snippet(content, 600)
  const title = docTitle.trim()
  return title ? `[文档] ${title}\n${body}` : body
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
    rrf_score: Math.round(c.rrf_score * 10000) / 10000,
  }
}

/**
 * 文档多样性约束（截断前）：第一遍按分序每 doc 最多取 maxPerDoc 条，溢出进队列；
 * 第一遍不足 topK 时按分从溢出补齐（不因多样性少给结果）。调用方随后 slice(0, topK)。
 */
function applyDocDiversity(ranked: FusedCandidate[], maxPerDoc: number): FusedCandidate[] {
  if (maxPerDoc <= 0) return ranked
  const picked: FusedCandidate[] = []
  const overflow: FusedCandidate[] = []
  const counts = new Map<string, number>()
  for (const c of ranked) {
    const n = counts.get(c.doc_id) ?? 0
    if (n < maxPerDoc) {
      picked.push(c)
      counts.set(c.doc_id, n + 1)
    } else {
      overflow.push(c)
    }
  }
  return [...picked, ...overflow]
}
