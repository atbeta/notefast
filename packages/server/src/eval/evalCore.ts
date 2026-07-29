/**
 * 检索评测核心（runEval CLI 与 eval 冒烟测试共用）
 *
 * 职责：
 * - 在临时目录搭建独立评测环境（initDb + 向量存储 + AI runtime）
 * - 语料 seed：走 docImport 真实入库路径（与 POST /docs 同一服务）
 * - 逐条查询调 hybridSearch（只读消费方，不改检索行为）
 * - 计算 Doc Recall@10 / Block Recall@20 / MRR / nDCG@10 / 无答案噪声 / 延迟
 *
 * 两种 embedding 模式：
 * - mock：确定性字符袋 64 维向量（同一文本恒同向量），CI 用，只验证管线接线
 * - live：读 ai.config.json 用真实 provider，seed 后 indexAllBlocks 全量建索引
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AiConfig } from '@notefast/core'
import { createPluginSystem } from '@notefast/core'
import { initDb, closeDb, getDb } from '../db'
import {
  initAiRuntime,
  applyNewConfig,
  getRuntime,
  hasRuntime,
  _setRuntimeForTests,
} from '../services/aiRuntime'
import { initVectorStore, indexAllBlocks, semanticSearch } from '../ai/indexer'
import { hybridSearch, type Citation } from '../ai/hybridSearch'
import { insertDocFromMarkdown } from '../services/docImport'
import { updateBlock } from '../store/blocks'
import { writeDocAiExclude } from '../ai/aiExclude'

// ───────────────────── 语料 / 查询文件格式 ─────────────────────

export interface CorpusDoc {
  title: string
  tags?: string[]
  /** 缺省 note；inbox=收集箱；archived=归档 */
  status?: 'note' | 'inbox' | 'archived'
  /** true = 对 AI 隐藏（软隔离） */
  ai_exclude?: boolean
  markdown: string
}

export interface CorpusFile {
  docs: CorpusDoc[]
}

export interface EvalQuery {
  id: string
  query: string
  /** title_exact / proper_noun / chinese_semantic / title_only_keyword /
   *  heading_path / code_error / multi_doc / no_answer / temporal … */
  type: string
  /** 相关文档标题（宁缺毋滥）；expect_empty 查询为空数组 */
  relevant_docs?: string[]
  /** 相关 block 的内容子串（用于 Block Recall@20） */
  relevant_blocks?: string[]
  /** true = 语料中无答案（难负样本），只做噪声信号统计 */
  expect_empty?: boolean
  note?: string
}

export interface QueriesFile {
  queries: EvalQuery[]
}

// ───────────────────── 评测环境 ─────────────────────

export interface EvalEnv {
  /** 临时数据目录（评测结束由 cleanup 删除） */
  dir: string
  notebookId: string
  /** 是否配置了 embedding（无 embedding 时语义通道指标为 null） */
  hasEmbedding: boolean
  cleanup: () => void
}

const MOCK_PROVIDER = {
  id: 'eval-mock',
  label: 'EvalMock',
  preset: 'custom' as const,
  baseUrl: 'https://eval.invalid/v1',
  apiKey: 'sk-eval-mock',
  embeddingModel: 'eval-mock-embedding',
  chatModel: '',
  timeoutMs: 10000,
  extraHeaders: {},
}

/**
 * 确定性字符袋向量：同一文本恒同向量。
 * 字符按 codePoint 散到 64 维（双哈希散开），L2 归一化。
 * 共享字符多的文本 cosine 高——不模拟语义，只保证管线可跑、可复现。
 */
export function deterministicVector(text: string, dim = 64): number[] {
  const v = new Array<number>(dim).fill(0)
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    v[code % dim]! += 1
    v[(code * 31 + 7) % dim]! += 0.5
  }
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}

/** mock 模式的 fetch 注入：拦截 /embeddings，按请求文本逐条返回确定性向量 */
export function makeDeterministicEmbedFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/embeddings')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string | string[] }
      const texts = Array.isArray(body.input) ? body.input : [body.input ?? '']
      return Response.json({
        data: texts.map((t) => ({ embedding: deterministicVector(t) })),
      })
    }
    return new Response('eval mock: 未拦截的端点 ' + url, { status: 404 })
  }) as unknown as typeof fetch
}

/**
 * 搭建评测环境：临时目录 → initDb → 向量存储 → AI runtime。
 * mock=true 注入确定性 embedding；否则加载 configPath（ai.config.json 新 schema）。
 */
export async function setupEvalEnv(opts: {
  mock: boolean
  configPath?: string
}): Promise<EvalEnv> {
  const dir = mkdtempSync(join(tmpdir(), 'notefast-eval-'))
  const { notebookId } = initDb(dir)
  await initVectorStore()
  const pluginSystem = createPluginSystem()
  initAiRuntime(pluginSystem, dir)

  if (opts.mock) {
    applyNewConfig(
      { version: 1, chat: null, embedding: MOCK_PROVIDER, autoIndex: false, reranker: null },
      pluginSystem,
    )
    getRuntime().setFetchImpl(makeDeterministicEmbedFetch())
  } else {
    if (!opts.configPath) throw new Error('活体模式需要 --config 指定 ai.config.json')
    const raw = await Bun.file(opts.configPath!).text()
    const cfg = JSON.parse(raw) as AiConfig
    if (!cfg.embedding) {
      console.warn('⚠️  配置无 embedding：退化为纯 FTS 评测（语义通道指标为 null）')
    }
    applyNewConfig({ ...cfg, autoIndex: false }, pluginSystem)
  }

  return {
    dir,
    notebookId,
    hasEmbedding: hasRuntime() && getRuntime().hasEmbedding(),
    cleanup: () => {
      _setRuntimeForTests(null)
      closeDb()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

// ───────────────────── 语料 seed ─────────────────────

/**
 * 语料入库：走 docImport 真实路径（Markdown → block 树），
 * archived / ai_exclude 在入库后按文档根补写。
 * 返回 标题 → docId 映射（重复标题直接报错，标注会失真）。
 */
export function seedCorpus(docs: CorpusDoc[], notebookId: string): Map<string, string> {
  const db = getDb()
  const titleToDocId = new Map<string, string>()
  for (const doc of docs) {
    if (titleToDocId.has(doc.title)) {
      throw new Error(`语料标题重复：${doc.title}`)
    }
    const { docId } = insertDocFromMarkdown(db, {
      notebookId,
      title: doc.title,
      markdown: doc.markdown,
      tags: doc.tags,
      status: doc.status === 'inbox' ? 'inbox' : undefined,
    })
    if (doc.status === 'archived') {
      updateBlock(db, docId, { status: 'archived' })
    }
    if (doc.ai_exclude) {
      writeDocAiExclude(docId, true)
    }
    titleToDocId.set(doc.title, docId)
  }
  // blocks_fts 无触发器，seed 后手动重建（与测试惯例一致）
  db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
  return titleToDocId
}

/** 全量建向量索引（无 embedding 时跳过，返回 null） */
export async function buildEvalIndex(notebookId: string): Promise<{ indexed: number; errors: number } | null> {
  if (!hasRuntime() || !getRuntime().hasEmbedding()) return null
  return await indexAllBlocks(notebookId)
}

// ───────────────────── 查询执行 ─────────────────────

export interface PerQueryResult {
  id: string
  query: string
  type: string
  latency_ms: number
  fts_hits: number
  semantic_hits: number
  citations: Citation[]
  /** expect_empty 查询的 top-1 语义 cosine（无 embedding 或无命中为 null） */
  top1_semantic_cosine: number | null
}

/** expect_empty 噪声：对同一份索引直接做 top-1 语义查询（默认过滤语义与 hybridSearch 一致） */
async function measureTop1SemanticCosine(query: string): Promise<number | null> {
  if (!hasRuntime() || !getRuntime().hasEmbedding()) return null
  try {
    const vec = await getRuntime().embedQuery(query)
    if (!vec) return null
    const hits = await semanticSearch(vec, 1)
    return hits.length > 0 ? hits[0]!.score : 0
  } catch {
    return null
  }
}

export async function runEvalQueries(
  queries: EvalQuery[],
  opts: { topK: number },
): Promise<PerQueryResult[]> {
  const results: PerQueryResult[] = []
  for (const q of queries) {
    const report = await hybridSearch({ query: q.query, topK: opts.topK })
    results.push({
      id: q.id,
      query: q.query,
      type: q.type,
      latency_ms: report.retrieval.timing.total_ms,
      fts_hits: report.retrieval.fts_hits,
      semantic_hits: report.retrieval.semantic_hits,
      citations: report.citations,
      top1_semantic_cosine: q.expect_empty ? await measureTop1SemanticCosine(q.query) : null,
    })
  }
  return results
}

// ───────────────────── 指标计算 ─────────────────────

const DOC_RECALL_K = 10
const BLOCK_RECALL_K = 20
const NDCG_K = 10

export interface QueryMetric {
  id: string
  query: string
  type: string
  latency_ms: number
  fts_hits: number
  semantic_hits: number
  doc_recall_at_10: number | null
  block_recall_at_20: number | null
  reciprocal_rank: number | null
  ndcg_at_10: number | null
  top1_semantic_cosine: number | null
  /** 未命中的相关文档标题（排查用） */
  missed_docs: string[]
  /** top5 文档标题（排查用） */
  top_doc_titles: string[]
}

export interface TypeMetric {
  count: number
  doc_recall_at_10: number | null
  block_recall_at_20: number | null
  mrr: number | null
  ndcg_at_10: number | null
}

export interface EvalReport {
  meta: {
    generated_at: string
    mode: 'mock' | 'live'
    corpus_docs: number
    query_count: number
    topk: number
    doc_recall_k: number
    block_recall_k: number
    ndcg_k: number
  }
  overall: {
    doc_recall_at_10: number | null
    block_recall_at_20: number | null
    mrr: number | null
    ndcg_at_10: number | null
    latency_p50_ms: number
    latency_p95_ms: number
    /** 无答案噪声信号（不做硬断言）；无 embedding 或无 expect_empty 查询为 null */
    empty_noise: {
      count: number
      top1_semantic_cosine_mean: number
      top1_semantic_cosine_max: number
    } | null
  }
  by_type: Record<string, TypeMetric>
  queries: QueryMetric[]
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function round(x: number | null, digits = 4): number | null {
  if (x === null) return null
  const f = 10 ** digits
  return Math.round(x * f) / f
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}

/** 单条查询指标：relevant_docs / relevant_blocks 为空时对应指标为 null（不参与聚合） */
function metricForQuery(
  q: EvalQuery,
  r: PerQueryResult,
  titleToDocId: Map<string, string>,
): QueryMetric {
  const relevantTitles = q.relevant_docs ?? []
  for (const t of relevantTitles) {
    if (!titleToDocId.has(t)) {
      throw new Error(`查询 ${q.id} 标注的相关文档不在语料中：${t}`)
    }
  }
  const relevantDocIds = new Set(relevantTitles.map((t) => titleToDocId.get(t)!))

  // Doc Recall@10：|相关 ∩ top10| / |相关|
  let docRecall: number | null = null
  let rr: number | null = null
  let ndcg: number | null = null
  const missed: string[] = []
  if (relevantDocIds.size > 0) {
    const top10 = r.citations.slice(0, DOC_RECALL_K)
    const hitDocIds = new Set(top10.map((c) => c.doc_id))
    const hits = [...relevantDocIds].filter((id) => hitDocIds.has(id)).length
    docRecall = hits / relevantDocIds.size
    for (const t of relevantTitles) {
      if (!hitDocIds.has(titleToDocId.get(t)!)) missed.push(t)
    }

    // MRR：首个相关 citation（按 doc 判定）的倒数排名
    rr = 0
    for (let i = 0; i < r.citations.length; i++) {
      if (relevantDocIds.has(r.citations[i]!.doc_id)) {
        rr = 1 / (i + 1)
        break
      }
    }

    // nDCG@10（二元相关性，按 doc 粒度去重——同一文档多个 citation 只计首次，
    // 否则 DCG 会超过以文档数计算的 IDCG，出现 nDCG > 1）
    let dcg = 0
    const seenDocs = new Set<string>()
    for (let i = 0; i < Math.min(r.citations.length, NDCG_K); i++) {
      const docId = r.citations[i]!.doc_id
      if (relevantDocIds.has(docId) && !seenDocs.has(docId)) {
        seenDocs.add(docId)
        dcg += 1 / Math.log2(i + 2)
      }
    }
    let idcg = 0
    const ideal = Math.min(relevantDocIds.size, NDCG_K)
    for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2)
    ndcg = idcg > 0 ? dcg / idcg : 0
  }

  // Block Recall@20：相关内容子串在 top20 citation 正文中的覆盖率
  let blockRecall: number | null = null
  const subs = q.relevant_blocks ?? []
  if (subs.length > 0) {
    const top20content = r.citations.slice(0, BLOCK_RECALL_K).map((c) => c.content)
    const found = subs.filter((s) => top20content.some((c) => c.includes(s))).length
    blockRecall = found / subs.length
  }

  return {
    id: q.id,
    query: q.query,
    type: q.type,
    latency_ms: r.latency_ms,
    fts_hits: r.fts_hits,
    semantic_hits: r.semantic_hits,
    doc_recall_at_10: round(docRecall),
    block_recall_at_20: round(blockRecall),
    reciprocal_rank: round(rr),
    ndcg_at_10: round(ndcg),
    top1_semantic_cosine: round(r.top1_semantic_cosine),
    missed_docs: missed,
    top_doc_titles: r.citations.slice(0, 5).map((c) => c.doc_title),
  }
}

function aggregateType(metrics: QueryMetric[]): TypeMetric {
  const pick = (f: (m: QueryMetric) => number | null) =>
    metrics.map(f).filter((x): x is number => x !== null)
  return {
    count: metrics.length,
    doc_recall_at_10: round(mean(pick((m) => m.doc_recall_at_10))),
    block_recall_at_20: round(mean(pick((m) => m.block_recall_at_20))),
    mrr: round(mean(pick((m) => m.reciprocal_rank))),
    ndcg_at_10: round(mean(pick((m) => m.ndcg_at_10))),
  }
}

export function computeMetrics(
  queries: EvalQuery[],
  results: PerQueryResult[],
  titleToDocId: Map<string, string>,
  meta: { mode: 'mock' | 'live'; corpusDocs: number; topk: number },
): EvalReport {
  const byId = new Map(results.map((r) => [r.id, r]))
  const queryMetrics = queries.map((q) => {
    const r = byId.get(q.id)
    if (!r) throw new Error(`查询 ${q.id} 无执行结果`)
    return metricForQuery(q, r, titleToDocId)
  })

  const byType: Record<string, QueryMetric[]> = {}
  for (const m of queryMetrics) {
    ;(byType[m.type] ??= []).push(m)
  }
  const typeMetrics: Record<string, TypeMetric> = {}
  for (const [type, ms] of Object.entries(byType)) {
    typeMetrics[type] = aggregateType(ms)
  }

  const noiseCosines = queryMetrics
    .filter((m) => m.top1_semantic_cosine !== null)
    .map((m) => m.top1_semantic_cosine!)
  const emptyCount = queries.filter((q) => q.expect_empty).length

  const latencies = queryMetrics.map((m) => m.latency_ms).sort((a, b) => a - b)
  const overall = aggregateType(queryMetrics)

  return {
    meta: {
      generated_at: new Date().toISOString(),
      mode: meta.mode,
      corpus_docs: meta.corpusDocs,
      query_count: queries.length,
      topk: meta.topk,
      doc_recall_k: DOC_RECALL_K,
      block_recall_k: BLOCK_RECALL_K,
      ndcg_k: NDCG_K,
    },
    overall: {
      doc_recall_at_10: overall.doc_recall_at_10,
      block_recall_at_20: overall.block_recall_at_20,
      mrr: overall.mrr,
      ndcg_at_10: overall.ndcg_at_10,
      latency_p50_ms: percentile(latencies, 50),
      latency_p95_ms: percentile(latencies, 95),
      empty_noise:
        noiseCosines.length > 0
          ? {
              count: emptyCount,
              top1_semantic_cosine_mean: round(mean(noiseCosines))!,
              top1_semantic_cosine_max: round(Math.max(...noiseCosines))!,
            }
          : null,
    },
    by_type: typeMetrics,
    queries: queryMetrics,
  }
}

// ───────────────────── 控制台摘要 ─────────────────────

export function formatSummary(report: EvalReport): string {
  const o = report.overall
  const pct = (x: number | null) => (x === null ? '  n/a' : (x * 100).toFixed(1).padStart(5) + '%')
  const lines: string[] = []
  lines.push('')
  lines.push(`══ 检索评测报告（${report.meta.mode} 模式）══`)
  lines.push(
    `语料 ${report.meta.corpus_docs} 篇 / 查询 ${report.meta.query_count} 条 / topK=${report.meta.topk}`,
  )
  lines.push('')
  lines.push(`Doc Recall@${report.meta.doc_recall_k} : ${pct(o.doc_recall_at_10)}`)
  lines.push(`Block Recall@${report.meta.block_recall_k}: ${pct(o.block_recall_at_20)}`)
  lines.push(`MRR              : ${o.mrr === null ? '  n/a' : o.mrr.toFixed(4)}`)
  lines.push(`nDCG@${report.meta.ndcg_k}           : ${o.ndcg_at_10 === null ? '  n/a' : o.ndcg_at_10.toFixed(4)}`)
  lines.push(`延迟 P50 / P95   : ${o.latency_p50_ms}ms / ${o.latency_p95_ms}ms`)
  if (o.empty_noise) {
    lines.push(
      `无答案噪声       : top-1 semantic cosine 均值 ${o.empty_noise.top1_semantic_cosine_mean.toFixed(4)} / 最大 ${o.empty_noise.top1_semantic_cosine_max.toFixed(4)}（n=${o.empty_noise.count}，信号指标）`,
    )
  } else {
    lines.push('无答案噪声       : n/a（无 embedding 或无 expect_empty 查询）')
  }
  lines.push('')
  lines.push('── 按查询类型分组 ──')
  const header = `${'type'.padEnd(20)} ${'n'.padStart(3)} ${'DocR@10'.padStart(8)} ${'BlkR@20'.padStart(8)} ${'MRR'.padStart(7)} ${'nDCG@10'.padStart(8)}`
  lines.push(header)
  for (const [type, m] of Object.entries(report.by_type).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `${type.padEnd(20)} ${String(m.count).padStart(3)} ${pct(m.doc_recall_at_10).padStart(8)} ${pct(m.block_recall_at_20).padStart(8)} ${(m.mrr === null ? 'n/a' : m.mrr.toFixed(3)).padStart(7)} ${(m.ndcg_at_10 === null ? 'n/a' : m.ndcg_at_10.toFixed(3)).padStart(8)}`,
    )
  }
  // 完全未命中的查询（召回 0）列出来便于排查
  const zero = report.queries.filter((m) => m.doc_recall_at_10 === 0)
  if (zero.length > 0) {
    lines.push('')
    lines.push(`── Doc Recall@10 = 0 的查询（${zero.length} 条）──`)
    for (const m of zero) {
      lines.push(`  [${m.id}] ${m.query}  缺失: ${m.missed_docs.join('、')}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}
