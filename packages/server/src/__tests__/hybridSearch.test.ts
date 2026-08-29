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
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import docs from '../api/docs'
import blocks from '../api/blocks'
import { createPluginSystem } from '@notefast/core'
import {
  initAiRuntime,
  applyNewConfig,
  _setRuntimeForTests,
} from '../services/aiRuntime'
import { hybridSearch, isShortCjkQuery } from '../ai/hybridSearch'
import { upsertVector, initVectorStore } from '../ai/indexer'
import { JsonVectorStore, setVectorStore } from '../ai/vectorStore'
import { insertRef } from '../store/refs'
import { upsertEntity, addMention } from '../store/entities'

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
  getDb().query('DELETE FROM block_refs').run()
  getDb().query('DELETE FROM entity_mentions').run()
  getDb().query('DELETE FROM entities').run()
  getDb().query(
    `UPDATE vector_store_state
     SET active_backend = 'json', status = 'stale', model_fingerprint = NULL,
         dimension = NULL, indexed_count = 0, error = NULL
     WHERE id = 'default'`,
  ).run()
  setVectorStore(new JsonVectorStore())
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

/** 种一篇含多个段落块的文档（多样性/上下文通道测试用） */
function seedDoc(opts: {
  notebookId: string
  title?: string
  contents: string[]
  idPrefix?: string
}) {
  const db = getDb()
  const now = new Date().toISOString()
  const docId = crypto.randomUUID()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
  ).run(docId, opts.notebookId, docId, opts.title ?? 'Untitled', now, now)
  const blockIds: string[] = []
  opts.contents.forEach((content, i) => {
    const id = opts.idPrefix ? `${opts.idPrefix}-${i}` : crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', ?, ?, 1, ?, ?)`,
    ).run(id, opts.notebookId, docId, docId, content, i, now, now)
    blockIds.push(id)
  })
  return { docId, blockIds }
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

describe('hybridSearch — precisionGate', () => {
  beforeEach(() => {
    applyNewConfig(
      {
        version: 1,
        chat: null,
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

  test('isShortCjkQuery：2 字中文为短查询，ASCII 不是', () => {
    expect(isShortCjkQuery('中二')).toBe(true)
    expect(isShortCjkQuery('备份')).toBe(true)
    expect(isShortCjkQuery('RAG')).toBe(false)
    expect(isShortCjkQuery('备份策略')).toBe(false)
  })

  test('纯语义低 cosine 不进引用；词法命中保留', async () => {
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl((async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 })) as unknown as typeof fetch)

    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const lexical = seedBlock({ id: 'gate-lex', notebookId: nb, content: 'Tauri window close handler' })
    const junk = seedBlock({ id: 'gate-junk', notebookId: nb, content: 'alpha beta gamma' })
    await upsertVector(lexical.id, new Float64Array([0.4, Math.sqrt(1 - 0.16)]))
    await upsertVector(junk.id, new Float64Array([0.4, Math.sqrt(1 - 0.16)]))

    const open = await hybridSearch({ query: 'Tauri', topK: 10 })
    expect(open.citations.some((c) => c.block_id === 'gate-junk')).toBe(true)

    const gated = await hybridSearch({ query: 'Tauri', topK: 10, precisionGate: true })
    expect(gated.citations.some((c) => c.block_id === 'gate-lex')).toBe(true)
    expect(gated.citations.some((c) => c.block_id === 'gate-junk')).toBe(false)
    expect(gated.retrieval.discarded_precision).toBeGreaterThan(0)
  })

  test('纯语义高 cosine 仍可进引用（换说法）', async () => {
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl((async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 })) as unknown as typeof fetch)

    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const para = seedBlock({ id: 'gate-hi', notebookId: nb, content: 'alpha beta gamma' })
    await upsertVector(para.id, new Float64Array([1, 0]))

    const report = await hybridSearch({ query: 'zztop', topK: 10, precisionGate: true })
    expect(report.retrieval.fts_hits).toBe(0)
    expect(report.citations.length).toBe(1)
    expect(report.citations[0]!.block_id).toBe('gate-hi')
  })

  test('≤2 字中文跳过语义路，无词法则 0 引用', async () => {
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl((async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 })) as unknown as typeof fetch)

    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const junk = seedBlock({ id: 'gate-cjk', notebookId: nb, content: '测试 2 视觉验证' })
    await upsertVector(junk.id, new Float64Array([1, 0]))

    const ungated = await hybridSearch({ query: '中二', topK: 10 })
    expect(ungated.retrieval.semantic_hits).toBeGreaterThan(0)

    const gated = await hybridSearch({ query: '中二', topK: 10, precisionGate: true })
    expect(gated.retrieval.semantic_hits).toBe(0)
    expect(gated.citations.length).toBe(0)
  })
})

describe('hybridSearch — includeArchived 透传到语义通道', () => {
  test('includeArchived=true 时 semantic 通道能命中 archived 块（P0 回归）', async () => {
    applyNewConfig(
      {
        version: 1,
        chat: null,
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
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl((async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 })) as unknown as typeof fetch)

    const db = getDb()
    const nb = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const now = new Date().toISOString()
    const seed = (docId: string, blockId: string, status: string) => {
      db.query(
        `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, status, sort, level, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'document', ?, ?, 0, 0, ?, ?)`,
      ).run(docId, nb, docId, `${status}-doc`, status, now, now)
      db.query(
        `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'paragraph', '语义召回专用内容', 0, 1, ?, ?)`,
      ).run(blockId, nb, docId, docId, now, now)
    }
    seed(crypto.randomUUID(), 'arch-sem-block', 'archived')
    seed(crypto.randomUUID(), 'note-sem-block', 'note')
    // 与查询同向的向量（cosine 1.0），查询文本无字面重叠 → 纯语义通道
    await upsertVector('arch-sem-block', new Float64Array([1, 0]))
    await upsertVector('note-sem-block', new Float64Array([1, 0]))

    const excluded = await hybridSearch({ query: 'zztop-arch', topK: 10 })
    expect(excluded.retrieval.semantic_hits).toBe(1)
    expect(excluded.citations.every((c) => c.block_id === 'note-sem-block')).toBe(true)

    const included = await hybridSearch({ query: 'zztop-arch', topK: 10, includeArchived: true })
    expect(included.retrieval.semantic_hits).toBe(2)
    expect(included.citations.some((c) => c.block_id === 'arch-sem-block')).toBe(true)
  })
})

describe('hybridSearch — reranker 原始分（去归一化）', () => {
  test('score 保留 reranker 原始分（不强制 1.0/0.5），rrf_score 恒为融合分', async () => {
    applyNewConfig(
      {
        version: 1,
        chat: null,
        embedding: null,
        autoIndex: false,
        reranker: {
          enabled: true,
          baseUrl: 'http://mock-rerank',
          apiKey: '',
          model: 'bge',
          timeoutMs: 5000,
        },
      },
      pluginSystem,
    )
    const { getRuntime } = await import('../services/aiRuntime')
    // TEI 协议：[{ index, score }]，原始分不落在 [0.5, 1] 归一区间
    getRuntime().setFetchImpl((async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rerank')) {
        return new Response(
          JSON.stringify([
            { index: 0, score: 0.83 },
            { index: 1, score: 0.12 },
          ]),
          { status: 200 },
        )
      }
      return new Response('unexpected', { status: 500 })
    }) as unknown as typeof fetch)

    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    seedBlock({ notebookId: nb, content: 'Tauri window close handler pattern' })
    seedBlock({ notebookId: nb, content: 'Tauri app packaging guide' })

    const report = await hybridSearch({ query: 'Tauri', topK: 10 })
    expect(report.retrieval.reranked).toBe(true)
    expect(report.retrieval.score_kind).toBe('rerank')
    expect(report.citations.length).toBe(2)
    // 原始分原样保留：第一名 0.83、最后一名 0.12（去归一化前恒为 1.0 / 0.5）
    expect(report.citations[0]!.score).toBe(0.83)
    expect(report.citations[1]!.score).toBe(0.12)
    // rrf_score 恒为融合分（~0.016 量级），与 score 不同尺度
    for (const c of report.citations) {
      expect(typeof c.rrf_score).toBe('number')
      expect(c.rrf_score).toBeGreaterThan(0)
      expect(c.rrf_score).toBeLessThan(0.1)
    }
    expect(report.citations[0]!.score).not.toBe(report.citations[0]!.rrf_score)

    // applyNewConfig 会写盘：复位 reranker，避免后续测试（beforeEach 重读磁盘配置）误走真实网络
    applyNewConfig(
      { version: 1, chat: null, embedding: null, autoIndex: false, reranker: null },
      pluginSystem,
    )
  })
})

describe('hybridSearch — 文档多样性约束（maxPerDoc）', () => {
  test('同一文档最多占 maxPerDoc 席（默认 2），其余名额给其他文档', async () => {
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const a = seedDoc({
      notebookId: nb,
      contents: ['Zebra 斑马条纹研究一', 'Zebra 斑马条纹研究二', 'Zebra 斑马条纹研究三'],
    })
    const b = seedDoc({ notebookId: nb, contents: ['Zebra 斑马迁徙笔记'] })

    const report = await hybridSearch({ query: 'Zebra', topK: 3 })
    expect(report.citations.length).toBe(3)
    // 3 个同文档块不能全占 top-3：A 文档 ≤ 2 席，B 文档进入结果
    expect(report.citations.filter((c) => c.doc_id === a.docId).length).toBe(2)
    expect(report.citations.filter((c) => c.doc_id === b.docId).length).toBe(1)
  })

  test('候选不足时按分从溢出补齐（不因多样性少给结果）', async () => {
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const a = seedDoc({
      notebookId: nb,
      contents: ['Zebra 斑马条纹研究一', 'Zebra 斑马条纹研究二', 'Zebra 斑马条纹研究三'],
    })

    const report = await hybridSearch({ query: 'Zebra', topK: 3 })
    // 只有 A 文档命中：先取 2 条，第 3 席由溢出队列补齐
    expect(report.citations.length).toBe(3)
    expect(report.citations.every((c) => c.doc_id === a.docId)).toBe(true)
  })
})

describe('hybridSearch — 图谱上下文通道（第 5 路 RRF 输入）', () => {
  test('自身 / 互链 / 共享实体文档的块都获得 RRF 票，当前文档块排最前', async () => {
    const db = getDb()
    const nb = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const ctx = seedDoc({
      notebookId: nb,
      title: '当前文档',
      idPrefix: 'ctx-block',
      contents: ['上下文文档的段落一', '上下文文档的段落二'],
    })
    const linked = seedDoc({
      notebookId: nb,
      title: '互链文档',
      idPrefix: 'link-block',
      contents: ['互链文档的段落一', '互链文档的段落二'],
    })
    const shared = seedDoc({
      notebookId: nb,
      title: '共享实体文档',
      idPrefix: 'ent-block',
      contents: ['共享实体文档的段落一', '共享实体文档的段落二'],
    })

    // 互链：当前文档块 → 互链文档块
    insertRef(db, { sourceId: ctx.blockIds[0]!, targetId: linked.blockIds[0]!, refType: 'manual' })
    // 共享实体：同一实体在当前文档与共享实体文档各有一条提及
    const entity = upsertEntity(db, { name: 'graphileon', display: 'Graphileon', kind: 'tool' })
    addMention(db, entity.id, ctx.blockIds[1]!, 'Graphileon')
    addMention(db, entity.id, shared.blockIds[0]!, 'Graphileon')

    // 查询与任何内容无字面重叠：词法/标题/实体通道均零命中，只有上下文通道出票
    const report = await hybridSearch({ query: 'zzzqqq', topK: 10, contextDocId: ctx.docId })
    expect(report.retrieval.fts_hits).toBe(0)
    expect(report.citations.length).toBeGreaterThanOrEqual(3)
    // 三段都进结果
    expect(report.citations.some((c) => c.doc_id === ctx.docId)).toBe(true)
    expect(report.citations.some((c) => c.doc_id === linked.docId)).toBe(true)
    expect(report.citations.some((c) => c.doc_id === shared.docId)).toBe(true)
    // 票序：自身 > 互链 > 共享实体（单通道内 RRF 分严格递减）
    expect(report.citations[0]!.doc_id).toBe(ctx.docId)
    const rankOf = (docId: string) =>
      report.citations.findIndex((c) => c.doc_id === docId)
    expect(rankOf(ctx.docId)).toBeLessThan(rankOf(linked.docId))
    expect(rankOf(linked.docId)).toBeLessThan(rankOf(shared.docId))
  })

  test('不传 contextDocId 时上下文通道不生效（行为与之前一致）', async () => {
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    seedDoc({ notebookId: nb, idPrefix: 'solo-block', contents: ['独自的段落'] })

    const report = await hybridSearch({ query: 'zzzqqq', topK: 10 })
    expect(report.citations.length).toBe(0)
  })
})

describe('hybridSearch — Citation 携带 rrf_score', () => {
  test('未配 reranker 时 score 与 rrf_score 同为 RRF 融合分，score_kind=rrf', async () => {
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    seedBlock({ notebookId: nb, content: 'Tauri 窗口关闭事件处理' })
    seedBlock({ notebookId: nb, content: 'Tauri 应用打包指南' })

    const report = await hybridSearch({ query: 'Tauri', topK: 10 })
    expect(report.retrieval.reranked).toBe(false)
    expect(report.retrieval.score_kind).toBe('rrf')
    expect(report.citations.length).toBeGreaterThan(0)
    for (const c of report.citations) {
      expect(typeof c.rrf_score).toBe('number')
      expect(c.score).toBe(c.rrf_score)
    }
  })
})

describe('删除文档 — 子块向量清理（回归：只 fire 文档根漏掉子块）', () => {
  // 手搭 Hono 只挂 docs/blocks 路由（避开 createApp 全量路由的 mammoth 等可选依赖）
  function makeApp() {
    const a = new Hono()
    a.route('/api/v1/docs', docs)
    a.route('/api/v1/blocks', blocks)
    return a
  }

  // upsertVector 需要 embedding fingerprint 非空；afterDelete hook 由 applyAutoIndex
  // 挂载，要求 hasEmbedding() 且 autoIndex=true（false 时 hook 不挂，向量不会清）
  beforeEach(() => {
    _setRuntimeForTests(null)
    initAiRuntime(pluginSystem, testDir)
    applyNewConfig(
      {
        version: 1,
        chat: null,
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
        autoIndex: true,
        reranker: null,
      },
      pluginSystem,
    )
  })

  test('DELETE /docs/:id 后所有子块向量被清空', async () => {
    const app = makeApp()
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const { docId, blockIds } = seedDoc({
      notebookId: nb,
      title: '待删除文档',
      contents: ['KMP 是高效的字符串匹配算法', '后缀数组用于字符串处理', 'Trie 树结构'],
      idPrefix: 'del-a',
    })

    // 给文档根 + 所有子块写入向量
    for (const bid of [docId, ...blockIds]) {
      await upsertVector(bid, new Float64Array([0.1, 0.2, 0.3]), `索引文本 ${bid}`)
    }
    const countBefore = (getDb().query('SELECT COUNT(*) AS n FROM block_vectors').get() as { n: number }).n
    expect(countBefore).toBe(4) // 1 根 + 3 子块

    const res = await app.fetch(new Request(`http://localhost/api/v1/docs/${docId}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)

    const countAfter = (getDb().query('SELECT COUNT(*) AS n FROM block_vectors').get() as { n: number }).n
    expect(countAfter).toBe(0) // 全部子块向量被清，无残留
  })

  test('删除单 block 仍清该块向量（单块路径不受影响）', async () => {
    const app = makeApp()
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const { id, docId } = seedBlock({ notebookId: nb, content: '单块删除测试' })
    await upsertVector(id, new Float64Array([0.5, 0.5, 0.5]), `索引文本 ${id}`)
    await upsertVector(docId, new Float64Array([0.9, 0.9, 0.9]), `索引文本 ${docId}`)

    const res = await app.fetch(new Request(`http://localhost/api/v1/blocks/${id}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)

    const after = (getDb().query('SELECT COUNT(*) AS n FROM block_vectors WHERE block_id = ?').get(id) as { n: number }).n
    expect(after).toBe(0)
    // 文档根向量保留
    const docVec = (getDb().query('SELECT COUNT(*) AS n FROM block_vectors WHERE block_id = ?').get(docId) as { n: number }).n
    expect(docVec).toBe(1)
  })
})
