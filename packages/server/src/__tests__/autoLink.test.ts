/**
 * AutoLink 测试（v4 —— 高置信直接建链，无人工审核）
 *
 * 覆盖：
 * - 抽取（mock LLM 返回的 JSON），锚点校验（长度、原文包含、kind 过滤）
 * - 建链门槛：语义命中 + minConfidence + minMargin → 直接写 block_refs（ref_type='ai_auto'）
 * - FTS-only / 低置信 / 低分差 / inbox / archived / ai_exclude → 不建链
 * - afterCreate / afterUpdate hook 行为（内容变化先清旧 ai_auto 再重评）
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { initDb, closeDb, getDb } from '../db'
import { createPluginSystem } from '@notefast/core'
import {
  initAiRuntime,
  applyNewConfig,
  _setRuntimeForTests,
  getRuntime,
} from '../services/aiRuntime'
import autoLinkRouter from '../api/autoLink'
import {
  analyzeBlock,
  listBlockIdsForDoc,
  _resetRateLimitForTests,
} from '../ai/autoLink'
import { getBlockById } from '../store/blocks'
import { insertRef } from '../store/refs'
import { contentHash, embeddingFingerprint, VECTOR_INDEX_VERSION } from '../ai/vectorStore'
import { initVectorStore } from '../ai/indexer'

let testDir: string
let pluginSystem: ReturnType<typeof createPluginSystem>
let app: Hono

function makeProvider(chatModel = 'gpt-4o-mini') {
  return {
    id: 'x',
    label: 'x',
    preset: 'custom',
    baseUrl: 'http://mock',
    apiKey: '',
    embeddingModel: '',
    chatModel,
    timeoutMs: 5000,
    extraHeaders: {},
  } as const
}

beforeAll(async () => {
  testDir = mkdtempSync(join('/tmp', 'notefast-autolink-'))
  initDb(testDir)
  await initVectorStore()
  pluginSystem = createPluginSystem()
  app = new Hono()
  app.use('*', cors({ origin: '*' }))
  app.route('/api/v1/auto-link', autoLinkRouter)
})

afterAll(() => {
  // 不泄漏带 mock fetch 的 AI runtime 给其他测试文件（bun 跨文件共享模块状态）
  _setRuntimeForTests(null)
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  _setRuntimeForTests(null)
  const configPath = join(testDir, 'ai.config.json')
  if (existsSync(configPath)) unlinkSync(configPath)
  initAiRuntime(pluginSystem, testDir)
  _resetRateLimitForTests()
  getDb().query('DELETE FROM blocks').run()
  getDb().query('DELETE FROM block_refs').run()
  getDb().query('DELETE FROM block_vectors').run()
  getDb().query(
    `UPDATE vector_store_state
     SET active_backend = 'json', status = 'stale', model_fingerprint = NULL,
         dimension = NULL, indexed_count = 0, error = NULL
     WHERE id = 'default'`,
  ).run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
})

function seedDocWithBlocks(opts: {
  docTitle: string
  blocks: Array<{ id?: string; content: string; type?: string }>
  notebookId?: string
  /** 文档状态（默认 'note'；inbox / archived 用于过滤测试） */
  status?: string
  /** 对 AI 隐藏 */
  aiExclude?: boolean
}): string {
  const db = getDb()
  const nb = opts.notebookId ?? crypto.randomUUID()
  db.query('INSERT OR IGNORE INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
  const docId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, status, ai_exclude, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, ?, ?, 0, 0, ?, ?)`,
  ).run(docId, nb, docId, opts.docTitle, opts.status ?? 'note', opts.aiExclude ? 1 : 0, now, now)
  let level = 1
  for (const b of opts.blocks) {
    const bid = b.id ?? crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(bid, nb, docId, docId, b.type ?? 'paragraph', b.content, level, now, now)
    level++
  }
  return docId
}

/** v4: 完整 autoLink 配置（限速放大到 1000，避免跨用例干扰；单测限速时显式覆盖） */
function testAutoLinkConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    notebookScope: 'all' as const,
    maxPerBlock: 5,
    minConfidence: 0.85,
    minMargin: 0.15,
    excludeAnchorKinds: ['tool'],
    excludeSelfDoc: true,
    rateLimitPerMinute: 1000,
    ...overrides,
  }
}

/** 应用 chat（可选 + embedding）配置并挂 hooks；fetch 由调用方自行 setFetchImpl */
function applyMockConfig(withEmbedding: boolean) {
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  applyNewConfig(
    {
      version: 1,
      chat: { ...makeProvider('gpt-4o-mini'), apiKey: 'key', baseUrl: 'http://mock', embeddingModel: '' } as never,
      embedding: withEmbedding
        ? ({
            ...makeProvider(''),
            apiKey: 'key',
            baseUrl: 'http://mock',
            chatModel: '',
            embeddingModel: 'mock-emb',
          } as never)
        : null,
      autoIndex: false,
      reranker: null,
      autoLink: testAutoLinkConfig(),
    },
    pluginSystem,
  )
}

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockChatReturning(jsonResponse: string) {
  applyMockConfig(false)
  getRuntime().setFetchImpl((async () => chatResponse(jsonResponse)) as unknown as typeof fetch)
}

/**
 * 同时 mock chat（抽取）与 embedding（语义重排）：
 * embedQuery 固定返回 queryVector；候选向量需自行 INSERT 进 block_vectors。
 */
function mockChatAndEmbedding(jsonResponse: string, queryVector: number[]) {
  applyMockConfig(true)
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/embeddings')) {
      return new Response(JSON.stringify({ data: [{ embedding: queryVector }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return chatResponse(jsonResponse)
  }) as unknown as typeof fetch
  getRuntime().setFetchImpl(fetcher)
}

/** 给候选 block 写入语义向量（配合 mockChatAndEmbedding） */
function seedVector(blockId: string, vec: number[]) {
  const db = getDb()
  const provider = getRuntime().embeddingProviderDef()!
  const fingerprint = embeddingFingerprint(provider)
  const block = db.query('SELECT content FROM blocks WHERE id = ?').get(blockId) as { content: string }
  db.query(
    `INSERT INTO block_vectors
       (block_id, embedding, dim, embedding_model, content_hash, index_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    blockId,
    JSON.stringify(vec),
    vec.length,
    fingerprint,
    contentHash(block.content),
    VECTOR_INDEX_VERSION,
  )
  db.query(
    `UPDATE vector_store_state
     SET status = 'ready', model_fingerprint = ?, dimension = ?,
         indexed_count = (SELECT count(*) FROM block_vectors), error = NULL
     WHERE id = 'default'`,
  ).run(fingerprint, vec.length)
}

function refCount(sourceId?: string): number {
  const db = getDb()
  if (sourceId) {
    return (db.query('SELECT count(*) as c FROM block_refs WHERE source_id = ?').get(sourceId) as { c: number }).c
  }
  return (db.query('SELECT count(*) as c FROM block_refs').get() as { c: number }).c
}

async function api(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await app.fetch(new Request(`http://localhost/api/v1/auto-link${path}`, init))
  return { status: res.status, body: await res.json() }
}

describe('AutoLink — 抽取与解析', () => {
  test('LLM 返回有效 JSON → 提取 mentions（无候选则不建链，分析计入 usage）', async () => {
    mockChatReturning(JSON.stringify({
      mentions: [
        { anchor: 'KMP', kind: 'concept' },
        { anchor: '字符串匹配', kind: 'concept' },
      ],
    }))
    seedDocWithBlocks({
      docTitle: 'x',
      blocks: [{ id: 'b1', content: '这是关于 KMP 和字符串匹配的笔记' }],
    })
    const r = await analyzeBlock({
      blockId: 'b1',
      content: '这是关于 KMP 和字符串匹配的笔记',
      notebookId: 'T',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.analyzed).toBe(1)
    expect(r.applied).toBe(0) // 没东西可匹配（库中只有它自己）
    expect(getRuntime().status().usage.autoLinkAnalyses).toBeGreaterThan(0)
  })

  test('anchor 不在原文 → 解析层过滤，只对原文内的锚点建链', async () => {
    mockChatAndEmbedding(JSON.stringify({
      mentions: [
        { anchor: 'Rust', kind: 'concept' }, // 原文里没有 → 过滤
        { anchor: 'KMP', kind: 'concept' },
      ],
    }), [1, 0])
    seedDocWithBlocks({
      docTitle: '目标',
      blocks: [{ id: 'tgt', content: 'KMP 算法详解' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: 'src', content: '这是关于 KMP 的笔记' }],
    })
    seedVector('tgt', [1, 0])

    const r = await analyzeBlock({
      blockId: 'src',
      content: '这是关于 KMP 的笔记',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    expect(r.applied).toBe(1)
    expect(r.links[0]!.anchor).toBe('KMP')
  })

  test('过短内容（<10 字）短路返回 0', async () => {
    mockChatReturning(JSON.stringify({ mentions: [] }))
    const r = await analyzeBlock({
      blockId: 'tiny',
      content: 'abc',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.analyzed).toBe(0)
  })
})

describe('AutoLink — 建链门槛', () => {
  /** 高置信：语义命中 + 过阈值 + 分差足够 → 直接写 block_refs */
  test('cosine ≥ 阈值且 margin 足够 → 直接建链（ref_type=ai_auto）', async () => {
    mockChatAndEmbedding(JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    seedDocWithBlocks({
      docTitle: '目标',
      blocks: [{ id: 'hi-tgt', content: 'KMP 算法的 next 数组构造' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: 'hi-src', content: 'KMP 是高效的字符串匹配' }],
    })
    seedVector('hi-tgt', [1, 0])

    const r = await analyzeBlock({
      blockId: 'hi-src',
      content: 'KMP 是高效的字符串匹配',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    expect(r.applied).toBe(1)
    expect(r.links[0]).toMatchObject({ anchor: 'KMP', targetBlockId: 'hi-tgt', confidence: 1 })

    const rows = getDb()
      .query('SELECT * FROM block_refs WHERE source_id = ? AND target_id = ?')
      .all('hi-src', 'hi-tgt') as Array<{ ref_type: string }>
    expect(rows.length).toBe(1)
    expect(rows[0]!.ref_type).toBe('ai_auto')
  })

  /** 无 embedding provider 时，纯 FTS 字面命中不建链 */
  test('FTS-only 字面命中 → 不建链', async () => {
    mockChatReturning(JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }))
    seedDocWithBlocks({
      docTitle: '目标',
      blocks: [{ id: 'fts-tgt', content: 'KMP 算法的 next 数组' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: 'fts-src', content: 'KMP 是高效的字符串匹配' }],
    })

    const r = await analyzeBlock({
      blockId: 'fts-src',
      content: 'KMP 是高效的字符串匹配',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    expect(r.applied).toBe(0)
    expect(refCount()).toBe(0)
    expect(r.skippedLowConfidence).toBeGreaterThan(0)
    expect(r.skippedAnchors?.some((s) => s.reason === 'fts_only')).toBe(true)
  })

  /** 语义分低于 minConfidence → 不建链 */
  test('cosine 低于 minConfidence → 不建链', async () => {
    mockChatAndEmbedding(JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    seedDocWithBlocks({
      docTitle: '目标',
      blocks: [{ id: 'low-tgt', content: 'KMP 算法的 next 数组' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: 'low-src', content: 'KMP 是高效的字符串匹配' }],
    })
    // 与查询向量垂直 → cosine 0，低于门槛
    seedVector('low-tgt', [0, 1])

    const r = await analyzeBlock({
      blockId: 'low-src',
      content: 'KMP 是高效的字符串匹配',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    expect(r.applied).toBe(0)
    expect(r.analyzed).toBe(1)
    expect(refCount()).toBe(0)
    expect(r.skippedLowConfidence).toBe(1)
    expect(r.skippedAnchors?.[0]?.reason).toBe('low_confidence')
  })

  /** top1 与 top2 分差不足 minMargin → 歧义，不建链 */
  test('top1/top2 分差不足 → 不建链', async () => {
    mockChatAndEmbedding(JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    seedDocWithBlocks({
      docTitle: '目标一',
      blocks: [{ id: 'mg-t1', content: 'KMP 算法的 next 数组' }],
    })
    seedDocWithBlocks({
      docTitle: '目标二',
      blocks: [{ id: 'mg-t2', content: 'KMP 算法复杂度证明' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: 'mg-src', content: 'KMP 是高效的字符串匹配' }],
    })
    // 两个候选与查询向量完全一致 → top1 == top2，margin = 0
    seedVector('mg-t1', [1, 0])
    seedVector('mg-t2', [1, 0])

    const r = await analyzeBlock({
      blockId: 'mg-src',
      content: 'KMP 是高效的字符串匹配',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    expect(r.applied).toBe(0)
    expect(refCount()).toBe(0)
    expect(r.skippedAnchors?.some((s) => s.reason === 'low_margin')).toBe(true)
  })

  /** 已存在同 (source, target) 引用 → 不重复建链 */
  test('已有引用 → 不重复建链', async () => {
    mockChatAndEmbedding(JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    seedDocWithBlocks({
      docTitle: '目标',
      blocks: [{ id: 'dup-tgt', content: 'KMP 算法的 next 数组构造' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: 'dup-src', content: 'KMP 是高效的字符串匹配' }],
    })
    seedVector('dup-tgt', [1, 0])
    insertRef(getDb(), { sourceId: 'dup-src', targetId: 'dup-tgt', refType: 'link' })

    const r = await analyzeBlock({
      blockId: 'dup-src',
      content: 'KMP 是高效的字符串匹配',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    expect(r.applied).toBe(0)
    expect(refCount('dup-src')).toBe(1) // 只有手工那条
    expect(r.skippedAnchors?.some((s) => s.reason === 'already_linked')).toBe(true)
  })

  /** kind=tool 的锚点被 excludeAnchorKinds 默认过滤 */
  test('kind=tool 锚点被默认过滤，concept 正常建链', async () => {
    mockChatAndEmbedding(JSON.stringify({
      mentions: [
        { anchor: 'notefast_create_doc', kind: 'tool' },
        { anchor: 'KMP', kind: 'concept' },
      ],
    }), [1, 0])
    seedDocWithBlocks({
      docTitle: '工具说明',
      blocks: [{ id: 'kind-tgt1', content: 'notefast_create_doc 工具说明' }],
    })
    seedDocWithBlocks({
      docTitle: '算法',
      blocks: [{ id: 'kind-tgt2', content: 'KMP 算法详解' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: 'kind-src', content: '调用 notefast_create_doc 创建，比如 KMP 笔记' }],
    })
    seedVector('kind-tgt1', [1, 0])
    seedVector('kind-tgt2', [1, 0])

    const r = await analyzeBlock({
      blockId: 'kind-src',
      content: '调用 notefast_create_doc 创建，比如 KMP 笔记',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    // 只剩 KMP（concept）一条；tool 锚点被过滤
    expect(r.applied).toBe(1)
    expect(r.links[0]!.anchor).toBe('KMP')
    expect(r.links[0]!.targetBlockId).toBe('kind-tgt2')
  })

  /** excludeSelfDoc：同一文档内的 block 不作为候选 */
  test('excludeSelfDoc 同文档候选被过滤', async () => {
    mockChatAndEmbedding(JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    // 源块与目标块在同一个文档（root_id 相同）
    seedDocWithBlocks({
      docTitle: '同一文档',
      blocks: [
        { id: 'self-src', content: 'KMP 是高效的字符串匹配' },
        { id: 'self-tgt', content: 'KMP 算法的 next 数组构造' },
      ],
    })
    seedVector('self-tgt', [1, 0])

    const r = await analyzeBlock({
      blockId: 'self-src',
      content: 'KMP 是高效的字符串匹配',
      notebookId: 'T',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    expect(r.applied).toBe(0)
    expect(refCount()).toBe(0)
  })

  /** rateLimitPerMinute：超出窗口配额的触发直接跳过 */
  test('rateLimitPerMinute 超出后直接跳过', async () => {
    _setRuntimeForTests(null)
    initAiRuntime(pluginSystem, testDir)
    applyNewConfig(
      {
        version: 1,
        chat: { ...makeProvider('gpt-4o-mini'), apiKey: 'key', baseUrl: 'http://mock', embeddingModel: '' } as never,
        embedding: null,
        autoIndex: false,
        reranker: null,
        autoLink: testAutoLinkConfig({ rateLimitPerMinute: 1 }),
      },
      pluginSystem,
    )
    getRuntime().setFetchImpl((async () =>
      chatResponse(JSON.stringify({ mentions: [] }))) as unknown as typeof fetch)
    seedDocWithBlocks({
      docTitle: '限速',
      blocks: [
        { id: 'rl-1', content: '第一条内容足够长用于分析' },
        { id: 'rl-2', content: '第二条内容足够长用于分析' },
      ],
    })

    const r1 = await analyzeBlock({ blockId: 'rl-1', content: '第一条内容足够长用于分析', notebookScope: 'all', maxPerBlock: 5 })
    expect(r1.rateLimited).toBeFalsy()
    const r2 = await analyzeBlock({ blockId: 'rl-2', content: '第二条内容足够长用于分析', notebookScope: 'all', maxPerBlock: 5 })
    expect(r2.rateLimited).toBe(true)
    expect(r2.analyzed).toBe(0)
  })
})

describe('AutoLink — 文档状态过滤', () => {
  /** inbox / archived 文档的 block 不作候选 */
  test.each(['inbox', 'archived'])('%s 文档的 block 不作候选', async (status) => {
    mockChatAndEmbedding(JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    seedDocWithBlocks({
      docTitle: '被过滤的目标',
      status,
      blocks: [{ id: `st-tgt-${status}`, content: 'KMP 算法的 next 数组构造' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: `st-src-${status}`, content: 'KMP 是高效的字符串匹配' }],
    })
    seedVector(`st-tgt-${status}`, [1, 0])

    const r = await analyzeBlock({
      blockId: `st-src-${status}`,
      content: 'KMP 是高效的字符串匹配',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    expect(r.applied).toBe(0)
    expect(refCount()).toBe(0)
    expect(r.skippedAnchors?.some((s) => s.reason === 'no_candidates')).toBe(true)
  })

  /** ai_exclude 文档的 block 不作候选（既有行为不变） */
  test('ai_exclude 文档的 block 不作候选', async () => {
    mockChatAndEmbedding(JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    seedDocWithBlocks({
      docTitle: '隐藏目标',
      aiExclude: true,
      blocks: [{ id: 'ax-tgt', content: 'KMP 算法的 next 数组构造' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: 'ax-src', content: 'KMP 是高效的字符串匹配' }],
    })
    seedVector('ax-tgt', [1, 0])

    const r = await analyzeBlock({
      blockId: 'ax-src',
      content: 'KMP 是高效的字符串匹配',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    expect(r.applied).toBe(0)
    expect(refCount()).toBe(0)
  })

  /** ai_exclude 文档的 block 不被分析（既有行为不变） */
  test('ai_exclude 文档的源块不被分析', async () => {
    mockChatAndEmbedding(JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    seedDocWithBlocks({
      docTitle: '隐藏源',
      aiExclude: true,
      blocks: [{ id: 'ax-src2', content: 'KMP 是高效的字符串匹配' }],
    })

    const r = await analyzeBlock({
      blockId: 'ax-src2',
      content: 'KMP 是高效的字符串匹配',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.analyzed).toBe(0)
    expect(r.applied).toBe(0)
  })
})

describe('AutoLink — hooks E2E', () => {
  /** afterCreate hook：新块内容高置信命中 → 自动建链 */
  test('afterCreate hook 自动建链', async () => {
    mockChatAndEmbedding(JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    seedDocWithBlocks({
      docTitle: '目标',
      blocks: [{ id: 'hk-tgt', content: 'KMP 算法的 next 数组构造' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: 'hk-src', content: 'KMP 是高效的字符串匹配' }],
    })
    seedVector('hk-tgt', [1, 0])

    const block = getBlockById(getDb(), 'hk-src')!
    await pluginSystem.note.afterCreate.call(block as never)

    const rows = getDb()
      .query('SELECT * FROM block_refs WHERE source_id = ? AND target_id = ?')
      .all('hk-src', 'hk-tgt') as Array<{ ref_type: string }>
    expect(rows.length).toBe(1)
    expect(rows[0]!.ref_type).toBe('ai_auto')
  })

  /** afterUpdate hook：先清旧 ai_auto 引用，再按新内容重评 */
  test('afterUpdate 先清旧 ai_auto 再重建（内容不再提及 → 旧链消失）', async () => {
    applyMockConfig(true)
    // 第一次 chat 返回 KMP 锚点，之后返回空 mentions（模拟内容改写）
    let chatCalls = 0
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/embeddings')) {
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      chatCalls++
      const content = chatCalls === 1
        ? JSON.stringify({ mentions: [{ anchor: 'KMP', kind: 'concept' }] })
        : JSON.stringify({ mentions: [] })
      return chatResponse(content)
    }) as unknown as typeof fetch
    getRuntime().setFetchImpl(fetcher)

    seedDocWithBlocks({
      docTitle: '目标',
      blocks: [{ id: 'up-tgt', content: 'KMP 算法的 next 数组构造' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: 'up-src', content: 'KMP 是高效的字符串匹配' }],
    })
    seedVector('up-tgt', [1, 0])

    // 创建时建链
    const created = getBlockById(getDb(), 'up-src')!
    await pluginSystem.note.afterCreate.call(created as never)
    expect(refCount('up-src')).toBe(1)

    // 内容改为不再提及 KMP → afterUpdate 清旧链且不再建新链
    getDb().query('UPDATE blocks SET content = ? WHERE id = ?').run('今天天气不错，随便记点什么', 'up-src')
    const updated = getBlockById(getDb(), 'up-src')!
    await pluginSystem.note.afterUpdate.call(updated as never)
    expect(refCount('up-src')).toBe(0)
  })

  /** inbox / archived 文档的块不触发 hook 分析 */
  test.each(['inbox', 'archived'])('%s 文档的块不触发 hook 建链', async (status) => {
    mockChatAndEmbedding(JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    seedDocWithBlocks({
      docTitle: '目标',
      blocks: [{ id: `hs-tgt-${status}`, content: 'KMP 算法的 next 数组构造' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      status,
      blocks: [{ id: `hs-src-${status}`, content: 'KMP 是高效的字符串匹配' }],
    })
    seedVector(`hs-tgt-${status}`, [1, 0])

    const block = getBlockById(getDb(), `hs-src-${status}`)!
    await pluginSystem.note.afterCreate.call(block as never)
    expect(refCount(`hs-src-${status}`)).toBe(0)
  })
})

describe('AutoLink — HTTP routes', () => {
  test('POST /run 返回新形状（analyzed / applied / links）', async () => {
    mockChatAndEmbedding(JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    seedDocWithBlocks({
      docTitle: '目标',
      blocks: [{ id: 'api-tgt', content: 'KMP 算法的 next 数组构造' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: 'api-src', content: 'KMP 是高效的字符串匹配' }],
    })
    seedVector('api-tgt', [1, 0])

    const { status, body } = await api('POST', '/run', { block_id: 'api-src' })
    expect(status).toBe(200)
    expect(body.analyzed).toBe(1)
    expect(body.applied).toBe(1)
    expect(body.links[0].anchor).toBe('KMP')
    expect(body.links[0].targetBlockId).toBe('api-tgt')
    expect(body.rate_limited).toBe(false)
  })

  test('POST /run block 不存在 → 404', async () => {
    mockChatReturning(JSON.stringify({ mentions: [] }))
    const { status } = await api('POST', '/run', { block_id: 'ghost' })
    expect(status).toBe(404)
  })

  test('DELETE /refs 解除引用', async () => {
    mockChatReturning(JSON.stringify({ mentions: [] }))
    seedDocWithBlocks({
      docTitle: 'd',
      blocks: [
        { id: 'rm-src', content: 'source text' },
        { id: 'rm-tgt', content: 'target text' },
      ],
    })
    insertRef(getDb(), { sourceId: 'rm-src', targetId: 'rm-tgt', refType: 'ai_auto' })
    expect(refCount('rm-src')).toBe(1)

    const { status, body } = await api('DELETE', '/refs?source_id=rm-src&target_id=rm-tgt')
    expect(status).toBe(200)
    expect(body.deleted).toBe(1)
    expect(refCount('rm-src')).toBe(0)
  })

  test('listBlockIdsForDoc 返回 doc 下所有 block id', () => {
    const docId = seedDocWithBlocks({
      docTitle: 'T',
      blocks: [
        { id: 'p1', content: 'p1' },
        { id: 'p2', content: 'p2' },
      ],
    })
    const ids = listBlockIdsForDoc(docId)
    expect(ids.length).toBeGreaterThanOrEqual(3) // doc + 2 paragraphs
  })
})

describe('AutoLink — 配置文件字段真实生效（Bug 14 回归）', () => {
  /** 从 ai.config.json 磁盘加载的 excludeAnchorKinds 必须被引擎执行 */
  test('磁盘加载的 excludeAnchorKinds 生效：concept 被过滤', async () => {
    const { writeFileSync } = await import('node:fs')
    const provider = {
      id: 'x', label: 'x', preset: 'custom', baseUrl: 'http://mock',
      apiKey: 'key', embeddingModel: '', chatModel: 'gpt-4o-mini',
      timeoutMs: 5000, extraHeaders: {},
    }
    const embProvider = { ...provider, chatModel: '', embeddingModel: 'mock-emb' }
    writeFileSync(join(testDir, 'ai.config.json'), JSON.stringify({
      version: 1,
      chat: provider,
      embedding: embProvider,
      autoIndex: false,
      reranker: null,
      autoLink: {
        enabled: true,
        notebookScope: 'all',
        maxPerBlock: 5,
        minConfidence: 0.85,
        minMargin: 0.15,
        excludeAnchorKinds: ['concept'],   // ← 自定义：连 concept 也过滤
        excludeSelfDoc: true,
        rateLimitPerMinute: 100,
      },
    }, null, 2))

    _setRuntimeForTests(null)
    initAiRuntime(pluginSystem, testDir)
    // 确认 runtime 读到的是磁盘里的自定义值
    const al = getRuntime().autoLinkConfig()
    expect(al.excludeAnchorKinds).toEqual(['concept'])
    expect(al.rateLimitPerMinute).toBe(100)

    getRuntime().setFetchImpl((async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/embeddings')) {
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 })
      }
      return chatResponse(JSON.stringify({ mentions: [{ anchor: 'KMP', kind: 'concept' }] }))
    }) as unknown as typeof fetch)

    seedDocWithBlocks({
      docTitle: '目标',
      blocks: [{ id: 'cfg-tgt', content: 'KMP 算法的 next 数组' }],
    })
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: 'cfg-src', content: 'KMP 是高效的字符串匹配' }],
    })
    seedVector('cfg-tgt', [1, 0])

    const r = await analyzeBlock({
      blockId: 'cfg-src',
      content: 'KMP 是高效的字符串匹配',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    // concept 也在排除清单里 → 不建链
    expect(r.applied).toBe(0)
    expect(refCount()).toBe(0)
  })
})
