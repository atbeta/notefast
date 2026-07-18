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

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-hybrid-'))
  initDb(testDir)
  initVectorStore()
  pluginSystem = createPluginSystem()
  initAiRuntime(pluginSystem, testDir)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  getDb().query('DELETE FROM blocks').run()
  getDb().query('DELETE FROM block_vectors').run()
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
        active: {
          id: 'x',
          label: 'x',
          preset: 'custom',
          baseUrl: 'http://mock',
          apiKey: '',
          embeddingModel: 'fake-emb',
          chatModel: 'fake-chat',
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
        active: {
          id: 'x',
          label: 'x',
          preset: 'custom',
          baseUrl: 'http://mock',
          apiKey: '',
          embeddingModel: 'fake-emb',
          chatModel: 'fake-chat',
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
    upsertVector(a.id, v)
    upsertVector(b.id, v)
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
