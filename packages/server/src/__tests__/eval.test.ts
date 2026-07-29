/**
 * 检索评测管线冒烟测试（CI）
 *
 * 用 mock embedding 模式跑 fixtures 精简子集（10 篇语料 + 11 条查询），
 * 只断言管线不变量，不断言语义质量（语义质量靠活体模式人工跑报告）。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { getDb } from '../db'
import { getDocById } from '../store/blocks'
import { hybridSearch } from '../ai/hybridSearch'
import {
  setupEvalEnv,
  seedCorpus,
  buildEvalIndex,
  runEvalQueries,
  computeMetrics,
  type CorpusFile,
  type QueriesFile,
  type EvalEnv,
  type EvalQuery,
  type PerQueryResult,
} from '../eval/evalCore'

const FIXTURES = join(import.meta.dir, '..', 'eval', 'fixtures')

/** 10 篇子集：含 inbox / archived / ai_exclude 各一篇，覆盖过滤语义 */
const SUBSET_TITLES = [
  'SQLite 向量检索方案',
  'SQLite 备份方案',
  'FTS5 中文分词实践',
  'MCP 工具链搭建记录',
  '红烧肉做法',
  '健身记录：深蹲入门',
  '双链笔记的得与失',
  '灵感速记：语音笔记想法',
  '旧版部署脚本（已废弃）',
  '私人财务记录',
]

let env: EvalEnv
let titleToDocId: Map<string, string>
let queries: EvalQuery[]
let results: PerQueryResult[]

beforeAll(async () => {
  const corpus = (await Bun.file(join(FIXTURES, 'corpus.json')).json()) as CorpusFile
  const queriesFile = (await Bun.file(join(FIXTURES, 'queries.json')).json()) as QueriesFile

  const docs = corpus.docs.filter((d) => SUBSET_TITLES.includes(d.title))
  expect(docs.length).toBe(SUBSET_TITLES.length)

  // fixtures 中取 relevant_docs 全在子集内的查询 + 针对过滤态文档与 gibberish 的内联查询
  const subsetTitles = new Set(SUBSET_TITLES)
  queries = [
    ...queriesFile.queries.filter(
      (q) =>
        ['q01', 'q05', 'q09', 'q11', 'q13', 'q34', 'q53'].includes(q.id) &&
        (q.relevant_docs ?? []).every((t) => subsetTitles.has(t)),
    ),
    // 过滤态文档的独有关键词：默认检索不应命中
    { id: 't-inbox', query: '星尘语音速记', type: 'smoke_filter', relevant_docs: [] },
    { id: 't-archived', query: '古早部署流水线', type: 'smoke_filter', relevant_docs: [] },
    { id: 't-exclude', query: '蓝宝石基金定投', type: 'smoke_filter', relevant_docs: [] },
    // 语料完全不存在的 gibberish：FTS 通道必须零命中
    { id: 't-gibberish', query: 'zxqwvkjfbm', type: 'smoke_empty', relevant_docs: [], expect_empty: true },
  ]

  env = await setupEvalEnv({ mock: true })
  titleToDocId = seedCorpus(docs, env.notebookId)
  await buildEvalIndex(env.notebookId)
  results = await runEvalQueries(queries, { topK: 20 })
}, 30000)

afterAll(() => {
  env.cleanup()
})

describe('eval 管线冒烟', () => {
  test('全部查询执行无异常，报告字段完整', () => {
    expect(results.length).toBe(queries.length)
    const report = computeMetrics(queries, results, titleToDocId, {
      mode: 'mock',
      corpusDocs: SUBSET_TITLES.length,
      topk: 20,
    })
    expect(report.meta.mode).toBe('mock')
    expect(report.meta.query_count).toBe(queries.length)
    expect(report.overall.doc_recall_at_10).not.toBeNull()
    expect(report.overall.mrr).not.toBeNull()
    expect(report.overall.ndcg_at_10).not.toBeNull()
    expect(report.overall.latency_p50_ms).toBeGreaterThanOrEqual(0)
    expect(report.overall.latency_p95_ms).toBeGreaterThanOrEqual(0)
    expect(report.by_type['title_exact']?.count).toBeGreaterThan(0)
    expect(report.queries.length).toBe(queries.length)
    for (const r of results) {
      expect(r.latency_ms).toBeGreaterThanOrEqual(0)
    }
  })

  test('ai_exclude / inbox / archived 文档默认不出现在任何查询的 citations 中', () => {
    const filtered = new Set([
      titleToDocId.get('私人财务记录')!,
      titleToDocId.get('灵感速记：语音笔记想法')!,
      titleToDocId.get('旧版部署脚本（已废弃）')!,
    ])
    for (const r of results) {
      for (const c of r.citations) {
        expect(filtered.has(c.doc_id)).toBe(false)
      }
    }
  })

  test('显式 include 可放开 inbox / archived 过滤（证明过滤确实生效）', async () => {
    const withInbox = await hybridSearch({ query: '星尘语音速记', topK: 10, includeInbox: true })
    expect(withInbox.citations.some((c) => c.doc_id === titleToDocId.get('灵感速记：语音笔记想法'))).toBe(true)
    const withArchived = await hybridSearch({ query: '古早部署流水线', topK: 10, includeArchived: true })
    expect(withArchived.citations.some((c) => c.doc_id === titleToDocId.get('旧版部署脚本（已废弃）'))).toBe(true)
  })

  test('gibberish 查询 FTS 通道零命中', () => {
    const g = results.find((r) => r.id === 't-gibberish')!
    expect(g.fts_hits).toBe(0)
  })

  test('每条 citation 的 doc_id 都能回查到文档', () => {
    const db = getDb()
    for (const r of results) {
      for (const c of r.citations) {
        expect(getDocById(db, c.doc_id)).not.toBeNull()
      }
    }
  })
})
