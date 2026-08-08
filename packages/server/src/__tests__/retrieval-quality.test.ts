/**
 * Hybrid Search / 索引作业 / 质量基线 补充测试
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
import { indexBlock, hasFreshVector, initVectorStore } from '../ai/indexer'
import { buildIndexedText } from '../ai/indexedText'
import { getBlockById } from '../store/blocks'
import {
  scheduleDocIndex,
  getIndexJob,
  _resetIndexJobsForTests,
} from '../ai/indexJobs'

let testDir: string
let pluginSystem: ReturnType<typeof createPluginSystem>

const FULL_PROVIDER = {
  id: 'p1',
  label: 'Test',
  preset: 'custom' as const,
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-test',
  embeddingModel: 'emb',
  chatModel: '',
  timeoutMs: 10000,
  extraHeaders: {},
}

beforeAll(async () => {
  testDir = mkdtempSync(join('/tmp', 'notefast-quality-'))
  initDb(testDir)
  await initVectorStore()
  pluginSystem = createPluginSystem()
  initAiRuntime(pluginSystem, testDir)
})

afterAll(() => {
  _setRuntimeForTests(null)
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  _resetIndexJobsForTests()
  getDb().query('DELETE FROM blocks').run()
  getDb().query('DELETE FROM block_vectors').run()
  getDb().query('DELETE FROM notebooks').run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
})

function seedDoc(opts: {
  notebookId: string
  title: string
  content: string
  status?: 'note' | 'inbox' | 'archived'
  blockId?: string
}) {
  const db = getDb()
  const docId = crypto.randomUUID()
  const blockId = opts.blockId ?? crypto.randomUUID()
  const now = new Date().toISOString()
  const docStatus = opts.status ?? 'note'
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, tags, status, ai_exclude, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, '{}', '[]', ?, 0, 0, 0, ?, ?)`,
  ).run(docId, opts.notebookId, docId, opts.title, docStatus, now, now)
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, tags, status, ai_exclude, sort, level, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'paragraph', ?, '[]', 'note', 0, 0, 1, ?, ?)`,
  ).run(blockId, opts.notebookId, docId, docId, opts.content, now, now)
  return { docId, blockId }
}

describe('retrieval timing', () => {
  test('hybridSearch 返回分阶段 timing', async () => {
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    seedDoc({ notebookId: nb, title: 'NoteFast', content: 'NoteFast 混合检索与向量索引' })

    const report = await hybridSearch({ query: 'NoteFast 检索' })
    expect(report.retrieval.timing).toBeDefined()
    expect(report.retrieval.timing.total_ms).toBeGreaterThanOrEqual(0)
    expect(report.retrieval.timing.understand_ms).toBe(0) // 未请求查询理解
    expect(report.retrieval.timing.fts_ms).toBeGreaterThanOrEqual(0)
    expect(report.retrieval.timing.embed_query_ms).toBe(0) // 未配置 embedding
    expect(report.retrieval.timing.semantic_ms).toBe(0)
    expect(report.retrieval.timing.rerank_ms).toBe(0)
  })
})

describe('inbox 排除 RAG', () => {
  test('默认不返回收集箱文档；includeInbox 可放开', async () => {
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    seedDoc({
      notebookId: nb,
      title: '正式',
      content: '独有关键词 AlphaNoteFast',
      status: 'note',
      blockId: 'note-block',
    })
    seedDoc({
      notebookId: nb,
      title: '草稿',
      content: '独有关键词 AlphaNoteFast 收集箱',
      status: 'inbox',
      blockId: 'inbox-block',
    })

    const filtered = await hybridSearch({ query: 'AlphaNoteFast', topK: 10 })
    expect(filtered.citations.every((c) => c.block_id !== 'inbox-block')).toBe(true)
    expect(filtered.citations.some((c) => c.block_id === 'note-block')).toBe(true)

    const withInbox = await hybridSearch({ query: 'AlphaNoteFast', topK: 10, includeInbox: true })
    expect(withInbox.citations.some((c) => c.block_id === 'inbox-block')).toBe(true)
  })
})

describe('archived 排除 RAG', () => {
  test('默认不返回归档文档；includeArchived 可放开', async () => {
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    seedDoc({
      notebookId: nb,
      title: '活跃笔记',
      content: '独有关键词 BetaNoteFast',
      status: 'note',
      blockId: 'active-block',
    })
    seedDoc({
      notebookId: nb,
      title: '已修复的旧 Bug',
      content: '独有关键词 BetaNoteFast 归档',
      status: 'archived',
      blockId: 'archived-block',
    })

    const filtered = await hybridSearch({ query: 'BetaNoteFast', topK: 10 })
    expect(filtered.citations.every((c) => c.block_id !== 'archived-block')).toBe(true)
    expect(filtered.citations.some((c) => c.block_id === 'active-block')).toBe(true)

    const withArchived = await hybridSearch({ query: 'BetaNoteFast', topK: 10, includeArchived: true })
    expect(withArchived.citations.some((c) => c.block_id === 'archived-block')).toBe(true)
  })
})

describe('content_hash 跳过', () => {
  test('内容未变时 indexBlock 返回 skipped', async () => {
    applyNewConfig(
      {
        version: 1,
        chat: null,
        embedding: FULL_PROVIDER,
        autoIndex: false,
        reranker: null,
      },
      pluginSystem,
    )
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const { blockId } = seedDoc({ notebookId: nb, title: 'D', content: 'hello hash skip' })

    let embedCalls = 0
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl((async () => {
      embedCalls++
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 })
    }) as unknown as typeof fetch)

    const r1 = await indexBlock(blockId)
    expect(r1).toBe('indexed')
    expect(embedCalls).toBe(1)
    // freshness 以构建后的索引文本为准（标题/章节/标签上下文 + 正文）
    const indexedText = await buildIndexedText(getBlockById(getDb(), blockId)!)
    expect(hasFreshVector(blockId, indexedText)).toBe(true)

    const r2 = await indexBlock(blockId)
    expect(r2).toBe('skipped')
    expect(embedCalls).toBe(1)
  })
})

describe('上下文 freshness 联动', () => {
  test('改标题 / 章节 / 标签后，相关块 hasFreshVector 变 false', async () => {
    applyNewConfig(
      {
        version: 1,
        chat: null,
        embedding: FULL_PROVIDER,
        autoIndex: false,
        reranker: null,
      },
      pluginSystem,
    )
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const db = getDb()
    const docId = crypto.randomUUID()
    const headingId = crypto.randomUUID()
    const blockId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, tags, status, ai_exclude, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', '旧标题', '[]', 'note', 0, 0, 0, ?, ?)`,
    ).run(docId, nb, docId, now, now)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'heading', '旧章节', 0, 1, ?, ?)`,
    ).run(headingId, nb, docId, docId, now, now)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', '正文内容不变', 0, 2, ?, ?)`,
    ).run(blockId, nb, headingId, docId, now, now)

    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl((async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 })) as unknown as typeof fetch)

    expect(await indexBlock(blockId)).toBe('indexed')
    const freshOf = async () =>
      hasFreshVector(blockId, await buildIndexedText(getBlockById(db, blockId)!))
    expect(await freshOf()).toBe(true)

    // 标题变化 → 索引文本变 → 不再新鲜
    db.query('UPDATE blocks SET content = ? WHERE id = ?').run('新标题', docId)
    expect(await freshOf()).toBe(false)
    expect(await indexBlock(blockId)).toBe('indexed')
    expect(await freshOf()).toBe(true)

    // 章节变化 → 不再新鲜
    db.query('UPDATE blocks SET content = ? WHERE id = ?').run('新章节', headingId)
    expect(await freshOf()).toBe(false)
    expect(await indexBlock(blockId)).toBe('indexed')
    expect(await freshOf()).toBe(true)

    // 标签变化（root 行 tags 列）→ 不再新鲜
    db.query(`UPDATE blocks SET tags = '["新标签"]' WHERE id = ?`).run(docId)
    expect(await freshOf()).toBe(false)
  })
})

describe('文档级索引作业', () => {
  test('scheduleDocIndex 推进到 ready 并暴露进度字段', async () => {
    applyNewConfig(
      {
        version: 1,
        chat: null,
        embedding: FULL_PROVIDER,
        autoIndex: true,
        reranker: null,
      },
      pluginSystem,
    )
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const { docId, blockId } = seedDoc({ notebookId: nb, title: 'D', content: 'job progress block' })

    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl((async () => {
      return new Response(JSON.stringify({ data: [{ embedding: [0.2, 0.3, 0.4] }] }), { status: 200 })
    }) as unknown as typeof fetch)

    const job = scheduleDocIndex(docId, [blockId])
    expect(job).not.toBeNull()
    expect(job!.total_blocks).toBe(1)

    // 等待作业完成
    const deadline = Date.now() + 5000
    let latest = getIndexJob(job!.id)!
    while ((latest.state === 'pending' || latest.state === 'running') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30))
      latest = getIndexJob(job!.id)!
    }
    expect(latest.state).toBe('ready')
    expect(latest.done + latest.skipped).toBeGreaterThanOrEqual(1)
    expect(latest.elapsed_ms).toBeGreaterThanOrEqual(0)
  })

  test('getIndexJobSummary 汇总 ready/active/recent/indexedBlocks', async () => {
    const { getIndexJobSummary } = await import('../ai/indexJobs')
    // beforeEach 重建了 runtime（默认 fetchImpl）：mock embedding 响应，否则作业会真实网络请求而 failed
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl((async () => {
      return new Response(JSON.stringify({ data: [{ embedding: [0.2, 0.3, 0.4] }] }), { status: 200 })
    }) as unknown as typeof fetch)
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const { docId, blockId } = seedDoc({ notebookId: nb, title: 'S', content: 'summary progress' })

    const job = scheduleDocIndex(docId, [blockId])
    expect(job).not.toBeNull()

    // 等待完成（running/pending 清零）
    const deadline = Date.now() + 5000
    let s = getIndexJobSummary()
    while ((s.running > 0 || s.pending > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30))
      s = getIndexJobSummary()
    }
    expect(s.ready).toBeGreaterThanOrEqual(1)
    expect(s.running).toBe(0)
    expect(s.pending).toBe(0)
    expect(s.active).toBeNull()
    expect(s.indexedBlocks).toBeGreaterThanOrEqual(1)
    expect(s.recent.length).toBeGreaterThanOrEqual(1)
  })

  test('running 作业被 supersede 后循环终止且状态保持 failed', async () => {
    applyNewConfig(
      {
        version: 1,
        chat: null,
        embedding: FULL_PROVIDER,
        autoIndex: true,
        reranker: null,
      },
      pluginSystem,
    )
    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const { docId } = seedDoc({ notebookId: nb, title: 'D', content: 'supersede target' })

    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl((async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0.2, 0.3, 0.4] }] }), { status: 200 })) as unknown as typeof fetch)

    // 200 个块 = 10 批，批间 50ms 间隔 → 足够的 running 窗口
    const ids = Array.from({ length: 200 }, () => crypto.randomUUID())
    const job1 = scheduleDocIndex(docId, ids)
    expect(job1).not.toBeNull()

    const deadline = Date.now() + 3000
    while (getIndexJob(job1!.id)!.state === 'pending' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(getIndexJob(job1!.id)!.state).toBe('running')

    // 同文档新作业 → job1 被 supersede（state 置 failed）
    scheduleDocIndex(docId, ids)
    expect(getIndexJob(job1!.id)!.state).toBe('failed')

    // 等过原本要跑完的时长：批前 state 检查应让循环自然终止，状态不被 finalize 覆盖
    await new Promise((r) => setTimeout(r, 700))
    const final1 = getIndexJob(job1!.id)!
    expect(final1.state).toBe('failed')
    expect(final1.error).toBe('被更新的索引作业取代')
    expect(final1.done + final1.skipped + final1.errors).toBeLessThan(200)
  })

  test('终态作业超过 100 个时淘汰最老的（Map 不单调增长）', () => {
    applyNewConfig(
      {
        version: 1,
        chat: null,
        embedding: FULL_PROVIDER,
        autoIndex: true,
        reranker: null,
      },
      pluginSystem,
    )
    // 空 blockIds 的 job 立即 ready（终态），用于快速堆量
    const ids: string[] = []
    for (let i = 0; i < 105; i++) {
      const job = scheduleDocIndex(crypto.randomUUID(), [])
      expect(job).not.toBeNull()
      ids.push(job!.id)
    }
    // 最老的 5 个已被淘汰；最新的 100 个保留
    for (const oldId of ids.slice(0, 5)) {
      expect(getIndexJob(oldId)).toBeNull()
    }
    expect(getIndexJob(ids[5]!)).not.toBeNull()
    expect(getIndexJob(ids[104]!)).not.toBeNull()
  })
})

/**
 * Golden set：固定中文 query → 期望块应出现在 topK。
 * 无 embedding 时走 FTS；用于回归检索质量基线。
 */
describe('golden-set retrieval', () => {
  const CASES: Array<{ query: string; expectId: string }> = [
    { query: 'sqlite-vec', expectId: 'g1' },
    { query: 'inbox draft', expectId: 'g2' },
    { query: 'MCP tools', expectId: 'g3' },
  ]

  test('FTS golden hit@5', async () => {
    // 纯 FTS 基线：关掉 embedding，避免假语义调用拖慢/干扰
    applyNewConfig(
      {
        version: 1,
        chat: null,
        embedding: null,
        autoIndex: false,
        reranker: null,
      },
      pluginSystem,
    )

    const nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    seedDoc({
      notebookId: nb,
      title: 'vectors',
      content: 'NoteFast uses sqlite-vec as the default vector backend',
      blockId: 'g1',
    })
    seedDoc({
      notebookId: nb,
      title: 'inbox',
      content: 'inbox draft notes are hidden from the main doc list',
      blockId: 'g2',
    })
    seedDoc({
      notebookId: nb,
      title: 'mcp',
      content: 'external agents use MCP tools to read and write the knowledge base',
      blockId: 'g3',
    })
    getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")

    let hits = 0
    for (const c of CASES) {
      const report = await hybridSearch({ query: c.query, topK: 5 })
      const ok = report.citations.some((x) => x.block_id === c.expectId)
      if (ok) hits++
      expect(report.retrieval.timing.total_ms).toBeGreaterThanOrEqual(0)
    }
    expect(hits).toBe(CASES.length)
  })
})
