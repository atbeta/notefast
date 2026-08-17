/**
 * 收集箱 / 归档文档不参与向量索引
 *
 * 与 hybridSearch 的 drop 集合（默认排除 inbox / archived）对齐：
 * - 存储层：indexBlock / indexBlockBatch / indexAllBlocks / 全量重建都跳过，
 *   并清掉已存在的向量（避免降级后留死锚）
 * - 状态切换：升格 note 触发整篇重索引；降级 inbox/archived 触发整篇清向量
 *   （doc.afterStatusChange hook，与 ai_exclude 的 applyAiExcludeChange 形态对齐）
 *
 * 与 ai_exclude 的差异：ai_exclude 走 properties.ai_exclude 列，inbox/archived
 * 走 status 列；两者均归并为「lifecycle 排除」语义。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createPluginSystem } from '@notefast/core'
import { initDb, closeDb, getDb } from '../db'
import {
  initAiRuntime,
  applyNewConfig,
  _setRuntimeForTests,
  getRuntime,
} from '../services/aiRuntime'
import { initVectorStore, indexBlock, indexBlockBatch, indexAllBlocks } from '../ai/indexer'
import { runVectorRebuild } from '../ai/vectorRebuild'
import { JsonVectorStore, setVectorStore } from '../ai/vectorStore'

let testDir: string
let notebookId: string
let pluginSystem: ReturnType<typeof createPluginSystem>

let embedInputs: string[] = []

const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/embeddings')) {
    const body = JSON.parse(init!.body as string)
    const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input]
    embedInputs.push(...inputs)
    return new Response(
      JSON.stringify({ data: inputs.map((_, i) => ({ embedding: [0.1, 0.2, 0.3], index: i })) }),
      { status: 200 },
    )
  }
  return new Response('not found', { status: 404 })
}) as unknown as typeof fetch

const EMBEDDING_PROVIDER = {
  id: 'e1',
  label: 'E',
  preset: 'custom' as const,
  baseUrl: 'http://mock/v1',
  apiKey: 'sk-test',
  embeddingModel: 'test-emb',
  chatModel: '',
  timeoutMs: 5000,
  extraHeaders: {},
}

function configure() {
  applyNewConfig(
    {
      version: 1,
      chat: null,
      embedding: EMBEDDING_PROVIDER,
      autoIndex: true,
      reranker: null,
    },
    pluginSystem,
  )
  getRuntime().setFetchImpl(fetcher)
}

beforeAll(async () => {
  testDir = mkdtempSync(join('/tmp', 'notefast-lifecycle-'))
  notebookId = initDb(testDir).notebookId
  pluginSystem = createPluginSystem()
  initAiRuntime(pluginSystem, testDir)
  await initVectorStore()
})

afterAll(() => {
  _setRuntimeForTests(null)
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  configure()
  embedInputs = []
  getDb().query('DELETE FROM blocks').run()
  // 重置 vector store state + 清 vec0 表，确保每个测试在 json backend 起跑
  getDb().query('DELETE FROM block_vectors').run()
  getDb().query(
    `UPDATE vector_store_state
     SET active_backend = 'json', status = 'stale', model_fingerprint = NULL,
         dimension = NULL, indexed_count = 0, error = NULL
     WHERE id = 'default'`,
  ).run()
  // 清理可能残留的 vec0 表与 trigger
  for (const r of getDb().query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_blocks_%'",
  ).all() as Array<{ name: string }>) {
    try { getDb().exec(`DROP TABLE IF EXISTS ${r.name}`) } catch { /* ignore */ }
  }
  for (const r of getDb().query(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'vec_blocks_%_block_delete'",
  ).all() as Array<{ name: string }>) {
    try { getDb().exec(`DROP TRIGGER IF EXISTS ${r.name}`) } catch { /* ignore */ }
  }
  getDb().query("DELETE FROM vector_generations").run()
  // 强制 json backend（runVectorRebuild 会切到 sqlite-vec，需要手动复位模块单例）
  setVectorStore(new JsonVectorStore())
})

function seedDoc(opts: {
  docId: string
  title: string
  status?: 'note' | 'inbox' | 'archived'
  blocks: Array<{ id: string; parentId: string; type?: string; content: string }>
}) {
  const db = getDb()
  const now = new Date().toISOString()
  const status = opts.status ?? 'note'
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, status, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, ?, 0, 0, ?, ?)`,
  ).run(opts.docId, notebookId, opts.docId, opts.title, status, now, now)
  for (const b of opts.blocks) {
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
    ).run(b.id, notebookId, b.parentId, opts.docId, b.type ?? 'paragraph', b.content, now, now)
  }
}

function countVectors(): number {
  // 读 vector_store_state.indexed_count：单一权威，覆盖 json / sqlite-vec 两后端
  const row = getDb()
    .query("SELECT indexed_count AS c FROM vector_store_state WHERE id = 'default'")
    .get() as { c: number } | null
  return row?.c ?? 0
}

describe('indexBlock 排除 lifecycle', () => {
  test('note 文档正常索引', async () => {
    const docId = crypto.randomUUID()
    const blockId = crypto.randomUUID()
    seedDoc({
      docId,
      title: '正常',
      status: 'note',
      blocks: [{ id: blockId, parentId: docId, content: '可被检索的内容' }],
    })
    const r = await indexBlock(blockId)
    expect(r).toBe('indexed')
    expect(embedInputs.length).toBe(1)
  })

  test('inbox 文档：indexBlock 返回 deleted，不调 embed', async () => {
    const docId = crypto.randomUUID()
    const blockId = crypto.randomUUID()
    seedDoc({
      docId,
      title: '收集',
      status: 'inbox',
      blocks: [{ id: blockId, parentId: docId, content: '不应被索引' }],
    })
    const r = await indexBlock(blockId)
    expect(r).toBe('deleted')
    expect(embedInputs.length).toBe(0)
  })

  test('archived 文档：indexBlock 返回 deleted，不调 embed', async () => {
    const docId = crypto.randomUUID()
    const blockId = crypto.randomUUID()
    seedDoc({
      docId,
      title: '归档',
      status: 'archived',
      blocks: [{ id: blockId, parentId: docId, content: '历史归档内容' }],
    })
    const r = await indexBlock(blockId)
    expect(r).toBe('deleted')
    expect(embedInputs.length).toBe(0)
  })

  test('子块通过 root_id 解析 status（不只看自身 status）', async () => {
    // 子块的 status 列可能与文档根不同（updateBlock 可单独写），但 lifecycle
    // 判定以 root_id 文档根为准——与 isBlockAiExcluded 同语义
    const docId = crypto.randomUUID()
    const blockId = crypto.randomUUID()
    seedDoc({
      docId,
      title: '收',
      status: 'inbox',
      blocks: [{ id: blockId, parentId: docId, content: '子块独立 status 但根是 inbox' }],
    })
    // 强制把子块 status 改回 note（模拟 status 不同步的脏数据）
    getDb().query("UPDATE blocks SET status = 'note' WHERE id = ?").run(blockId)
    const r = await indexBlock(blockId)
    expect(r).toBe('deleted')
    expect(embedInputs.length).toBe(0)
  })
})

describe('lifecycle exclude 清理已有向量', () => {
  test('indexBlock 对 inbox 文档：清掉先前的向量', async () => {
    const docId = crypto.randomUUID()
    const blockId = crypto.randomUUID()
    seedDoc({
      docId,
      title: '临',
      status: 'note',
      blocks: [{ id: blockId, parentId: docId, content: '初始索引' }],
    })
    // 1. note 状态下建立向量
    const r1 = await indexBlock(blockId)
    expect(r1).toBe('indexed')
    expect(countVectors()).toBeGreaterThan(0)

    // 2. 改成 inbox，再次调用 indexBlock → 应清掉
    getDb().query("UPDATE blocks SET status = 'inbox' WHERE id = ?").run(docId)
    const r2 = await indexBlock(blockId)
    expect(r2).toBe('deleted')
    expect(countVectors()).toBe(0)
  })
})

describe('indexBlockBatch 排除 lifecycle', () => {
  test('混合 batch：只 note 进 embed，inbox/archived 清理', async () => {
    const noteDoc = crypto.randomUUID()
    const inboxDoc = crypto.randomUUID()
    const archivedDoc = crypto.randomUUID()
    const noteBlock = crypto.randomUUID()
    const inboxBlock = crypto.randomUUID()
    const archivedBlock = crypto.randomUUID()
    seedDoc({
      docId: noteDoc,
      title: '正',
      status: 'note',
      blocks: [{ id: noteBlock, parentId: noteDoc, content: '正文字' }],
    })
    seedDoc({
      docId: inboxDoc,
      title: '收',
      status: 'inbox',
      blocks: [{ id: inboxBlock, parentId: inboxDoc, content: '草稿' }],
    })
    seedDoc({
      docId: archivedDoc,
      title: '归',
      status: 'archived',
      blocks: [{ id: archivedBlock, parentId: archivedDoc, content: '归档' }],
    })

    const result = await indexBlockBatch([noteBlock, inboxBlock, archivedBlock])
    expect(result.indexed).toBe(1)
    expect(embedInputs.length).toBe(1)
    expect(embedInputs[0]).toContain('正文字')
  })
})

describe('indexAllBlocks 排除 lifecycle', () => {
  test('全量重建路径只跑 note 文档', async () => {
    const noteDoc = crypto.randomUUID()
    const inboxDoc = crypto.randomUUID()
    const archivedDoc = crypto.randomUUID()
    seedDoc({
      docId: noteDoc,
      title: '正',
      status: 'note',
      blocks: [{ id: crypto.randomUUID(), parentId: noteDoc, content: '正文字段' }],
    })
    seedDoc({
      docId: inboxDoc,
      title: '收',
      status: 'inbox',
      blocks: [{ id: crypto.randomUUID(), parentId: inboxDoc, content: '草稿段' }],
    })
    seedDoc({
      docId: archivedDoc,
      title: '归',
      status: 'archived',
      blocks: [{ id: crypto.randomUUID(), parentId: archivedDoc, content: '归档段' }],
    })

    const r = await indexAllBlocks()
    expect(r.indexed).toBeGreaterThan(0)
    // 不应出现「草稿段」「归档段」字样
    expect(embedInputs.join('\n')).not.toContain('草稿段')
    expect(embedInputs.join('\n')).not.toContain('归档段')
    expect(embedInputs.join('\n')).toContain('正文字段')
  })
})

describe('runVectorRebuild 排除 lifecycle', () => {
  test('重建 SQL 过滤 inbox / archived', async () => {
    const noteDoc = crypto.randomUUID()
    const inboxDoc = crypto.randomUUID()
    const archivedDoc = crypto.randomUUID()
    const noteBlock = crypto.randomUUID()
    seedDoc({
      docId: noteDoc,
      title: '正',
      status: 'note',
      blocks: [{ id: noteBlock, parentId: noteDoc, content: '正文字段' }],
    })
    seedDoc({
      docId: inboxDoc,
      title: '收',
      status: 'inbox',
      blocks: [{ id: crypto.randomUUID(), parentId: inboxDoc, content: '草稿段' }],
    })
    seedDoc({
      docId: archivedDoc,
      title: '归',
      status: 'archived',
      blocks: [{ id: crypto.randomUUID(), parentId: archivedDoc, content: '归档段' }],
    })

    embedInputs = []
    const status = await runVectorRebuild()
    expect(status.status).toBe('ready')
    // doc 根 + note 的 block = 2 个
    expect(status.count).toBe(2)
    expect(embedInputs.join('\n')).not.toContain('草稿段')
    expect(embedInputs.join('\n')).not.toContain('归档段')
  })
})

describe('doc.afterStatusChange hook（applyAutoIndex）', () => {
  test('note → inbox：清掉整篇向量', async () => {
    const docId = crypto.randomUUID()
    const blockId = crypto.randomUUID()
    seedDoc({
      docId,
      title: '降',
      status: 'note',
      blocks: [{ id: blockId, parentId: docId, content: '开始是 note' }],
    })
    const r = await indexBlock(blockId)
    expect(r).toBe('indexed')
    expect(countVectors()).toBeGreaterThan(0)

    // 触发状态变更
    getDb().query("UPDATE blocks SET status = 'inbox' WHERE id = ?").run(docId)
    pluginSystem.doc.afterStatusChange.call({
      doc: { id: docId } as never,
      before: { status: 'note' },
      meta: { status: 'inbox' },
    })

    // 等 hook 异步完成（deleteVectorMany 是 await 的，理论上同步完成）
    await new Promise((r) => setTimeout(r, 30))
    expect(countVectors()).toBe(0)
  })

  test('note → archived：清掉整篇向量', async () => {
    const docId = crypto.randomUUID()
    const blockId = crypto.randomUUID()
    seedDoc({
      docId,
      title: '降',
      status: 'note',
      blocks: [{ id: blockId, parentId: docId, content: '开始是 note' }],
    })
    expect(await indexBlock(blockId)).toBe('indexed')

    getDb().query("UPDATE blocks SET status = 'archived' WHERE id = ?").run(docId)
    pluginSystem.doc.afterStatusChange.call({
      doc: { id: docId } as never,
      before: { status: 'note' },
      meta: { status: 'archived' },
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(countVectors()).toBe(0)
  })

  test('inbox → note（升格）：调度整篇重索引', async () => {
    const docId = crypto.randomUUID()
    const blockId = crypto.randomUUID()
    seedDoc({
      docId,
      title: '升',
      status: 'inbox',
      blocks: [{ id: blockId, parentId: docId, content: '草稿 → 升级' }],
    })
    // 升格前：inbox 不该有向量
    expect(countVectors()).toBe(0)

    getDb().query("UPDATE blocks SET status = 'note' WHERE id = ?").run(docId)
    pluginSystem.doc.afterStatusChange.call({
      doc: { id: docId } as never,
      before: { status: 'inbox' },
      meta: { status: 'note' },
    })

    // scheduleDocIndex 是后台批处理，给点时间让它跑
    await new Promise((r) => setTimeout(r, 200))
    expect(countVectors()).toBeGreaterThan(0)
  })

  test('未变化状态（inbox → inbox）：no-op', async () => {
    const docId = crypto.randomUUID()
    const blockId = crypto.randomUUID()
    seedDoc({
      docId,
      title: '保',
      status: 'inbox',
      blocks: [{ id: blockId, parentId: docId, content: '保持 inbox' }],
    })
    const before = countVectors()
    pluginSystem.doc.afterStatusChange.call({
      doc: { id: docId } as never,
      before: { status: 'inbox' },
      meta: { status: 'inbox' },
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(countVectors()).toBe(before)
  })
})