/**
 * Hybrid Search 单元测试
 *
 * 直接调用 hybridSearch() 验证：
 * - FTS5 单独命中
 * - 纯 FTS5 降级（embedding 未配置时不崩）
 * - RRF 合并后去重
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { createPluginSystem } from '@notefast/core'
import {
  initAiRuntime,
  applyNewConfig,
  _setRuntimeForTests,
} from '../services/aiRuntime'
import { hybridSearch } from '../ai/hybridSearch'
import { upsertVector, initVectorStore } from '../ai/indexer'

let testDir: string
let pluginSystem: ReturnType<typeof createPluginSystem>

beforeAll(async () => {
  testDir = mkdtempSync(join('/tmp', 'notefast-hybrid-'))
  initDb(testDir)
  await initVectorStore()
  pluginSystem = createPluginSystem()
  initAiRuntime(pluginSystem, testDir)
})

afterAll(() => {
  // 不泄漏带 mock fetch 的 AI runtime 给其他测试文件（bun 跨文件共享模块状态）
  _setRuntimeForTests(null)
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  getDb().query('DELETE FROM blocks').run()
  getDb().query('DELETE FROM block_vectors').run()
  getDb().query(
    `UPDATE vector_store_state
     SET active_backend = 'json', status = 'stale', model_fingerprint = NULL,
         dimension = NULL, indexed_count = 0, error = NULL
     WHERE id = 'default'`,
  ).run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
})

function seedBlock(opts: {
  id?: string
  notebookId: string
  type?: string
  content: string
  title?: string
}) {
  const db = getDb()
  const id = opts.id ?? crypto.randomUUID()
  const now = new Date().toISOString()
  // 文档头
  const docId = crypto.randomUUID()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
  ).run(docId, opts.notebookId, docId, opts.title ?? 'Untitled', now, now)
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
  ).run(id, opts.notebookId, docId, docId, opts.type ?? 'paragraph', opts.content, now, now)
  return { id, docId }
}

describe('hybridSearch — 纯 FTS5 降级', () => {
  test('embedding 未配置时仍然走 FTS5', async () => {
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    seedBlock({ notebookId: nb, content: 'Tauri 窗口关闭事件处理' })
    seedBlock({ notebookId: nb, content: 'React Hooks 入门' })

    const report = await hybridSearch({ query: 'Tauri' })
    expect(report.citations.length).toBeGreaterThan(0)
    expect(report.retrieval.fts_hits).toBeGreaterThan(0)
    expect(report.retrieval.semantic_hits).toBe(0) // 没有任何 embedding
    expect(report.retrieval.reranked).toBe(false)
  })
})

describe('hybridSearch — embedding + RRF', () => {
  beforeEach(() => {
    // 配置有 chat 但无 chat 调用时不影响 embedding
    applyNewConfig(
      {
        version: 1,
        chat: {
          id: 'x',
          label: 'x',
          preset: 'custom',
          baseUrl: 'http://mock-chat',
          apiKey: '',
          embeddingModel: '',
          chatModel: 'fake-chat',
          timeoutMs: 5000,
          extraHeaders: {},
        },
        embedding: {
          id: 'x-emb',
          label: 'x',
          preset: 'custom',
          baseUrl: 'http://mock-emb',
          apiKey: '',
          embeddingModel: 'fake-emb',
          chatModel: '',
          timeoutMs: 5000,
          extraHeaders: {},
        },
        autoIndex: false,
        reranker: null,
      },
      pluginSystem,
    )
  })

  test('embedding API 不通时降级到 FTS5', async () => {
    const fetcher = (async () => new Response('down', { status: 500 })) as unknown as typeof fetch
    _setRuntimeForTests(null)
    initAiRuntime(pluginSystem, testDir)
    applyNewConfig(
      {
        version: 1,
        chat: {
          id: 'x',
          label: 'x',
          preset: 'custom',
          baseUrl: 'http://mock',
          apiKey: '',
          embeddingModel: '',
          chatModel: 'fake-chat',
          timeoutMs: 5000,
          extraHeaders: {},
        },
        embedding: {
          id: 'x-emb',
          label: 'x',
          preset: 'custom',
          baseUrl: 'http://mock',
          apiKey: '',
          embeddingModel: 'fake-emb',
          chatModel: '',
          timeoutMs: 5000,
          extraHeaders: {},
        },
        autoIndex: false,
        reranker: null,
      },
      pluginSystem,
    )
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl(fetcher)

    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    seedBlock({ notebookId: nb, content: 'Rust async programming intro' })
    seedBlock({ notebookId: nb, content: 'JavaScript async programming intro' })

    const report = await hybridSearch({ query: 'Rust' })
    expect(report.retrieval.semantic_hits).toBe(0)
    expect(report.retrieval.fts_hits).toBeGreaterThan(0)
  })

  test('FTS + semantic 共同命中同一 block 时 RRF 累加', async () => {
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const a = seedBlock({ id: 'a-id', notebookId: nb, content: 'Tauri window close handler pattern' })
    const b = seedBlock({ id: 'b-id', notebookId: nb, content: 'unrelated content about food' })

    const v = new Float64Array([0.1, 0.2, 0.3])
    await upsertVector(a.id, v)
    await upsertVector(b.id, v)
    const fetcher = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
      })) as unknown as typeof fetch
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl(fetcher)

    const report = await hybridSearch({ query: 'Tauri close' })
    expect(report.citations.find((c) => c.block_id === 'a-id')).toBeDefined()
    expect(report.citations.length).toBeGreaterThan(0)
    expect(report.citations[0]!.block_id).toBe('a-id')
  })
})

describe('hybridSearch — minScore 引用过滤', () => {
  test('低于 minScore 的引用被过滤并计入 discarded_low_score', async () => {
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    seedBlock({ notebookId: nb, content: 'Tauri 窗口关闭事件处理' })
    seedBlock({ notebookId: nb, content: 'Tauri 应用打包指南' })
    seedBlock({ notebookId: nb, content: 'Tauri 与 Electron 对比' })

    const all = await hybridSearch({ query: 'Tauri', topK: 10 })
    expect(all.citations.length).toBeGreaterThan(0)
    const maxScore = Math.max(...all.citations.map((c) => c.score))
    expect(all.retrieval.discarded_low_score).toBe(0) // 不过滤时恒为 0

    // 用 maxScore 作为阈值 → 只剩 top-1（RRF 下每个 rank 分值唯一）
    const filtered = await hybridSearch({ query: 'Tauri', topK: 10, minScore: maxScore })
    expect(filtered.citations.length).toBe(1)
    expect(filtered.citations[0]!.score).toBe(maxScore)
    expect(filtered.retrieval.discarded_low_score).toBe(all.citations.length - 1)

    // 超高阈值 → 全部过滤（允许少于 topK，直至 0）
    const none = await hybridSearch({ query: 'Tauri', topK: 10, minScore: 1 })
    expect(none.citations.length).toBe(0)
    expect(none.retrieval.discarded_low_score).toBe(all.citations.length)
  })
})

describe('hybridSearch — 语义召回 cosine 下限（Bug 6）', () => {
  test('cosine < 0.3 的语义命中在召回层被过滤（短查询噪声截断）', async () => {
    // 配置 embedding（复用 describe 的 beforeEach 配置）
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl((async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 })) as unknown as typeof fetch)

    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    // 内容与查询文本无字面重叠（FTS 不命中，隔离出纯语义通道）
    const high = seedBlock({ id: 'hi-cos', notebookId: nb, content: 'alpha beta gamma' })
    const low = seedBlock({ id: 'lo-cos', notebookId: nb, content: 'delta epsilon zeta' })
    await upsertVector(high.id, new Float64Array([1, 0]))   // cosine 1.0 → 保留
    await upsertVector(low.id, new Float64Array([0, 1]))    // cosine 0.0 → 过滤

    const report = await hybridSearch({ query: 'zztop', topK: 10 })
    expect(report.retrieval.fts_hits).toBe(0)
    // 语义召回只剩高分那条
    expect(report.retrieval.semantic_hits).toBe(1)
    expect(report.citations.length).toBe(1)
    expect(report.citations[0]!.block_id).toBe('hi-cos')
  })
})
