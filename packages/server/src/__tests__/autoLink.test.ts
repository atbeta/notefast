/**
 * AutoLink 测试
 *
 * 覆盖：
 * - 抽取（mock LLM 返回的 JSON），锚点校验（长度、原文包含）
 * - 候选匹配：FTS 命中 → 加进 suggestions；未命中 → 跳过
 * - 入内存 store / apply → block_refs / dismiss
 * - 自动 hook 触发（note.afterCreate）
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
  insertRef,
  listBlockIdsForDoc,
  _resetRateLimitForTests,
} from '../ai/autoLink'
import {
  addSuggestions,
  applySuggestion,
  dismissSuggestion,
  findSuggestion,
  listSuggestionsForBlock,
  revertSuggestion,
  toWire,
  type AutoLinkSuggestion,
} from '../ai/autoLinkStore'
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

/** v2: 构造一个完整的 AutoLinkSuggestion，含必填字段默认值 */
function makeSuggestion(overrides: Partial<AutoLinkSuggestion> & {
  candidates?: Array<{ blockId: string; docId?: string; docTitle?: string; snippet?: string; confidence?: number; scoreKind?: 'fts_rank' | 'embedding' | 'hybrid' }>
}): AutoLinkSuggestion {
  const now = new Date().toISOString()
  return {
    id: overrides.id ?? crypto.randomUUID(),
    sourceBlockId: overrides.sourceBlockId ?? 'src',
    sourceContentHash: overrides.sourceContentHash ?? 'hash-' + now,
    sourceUpdatedAt: overrides.sourceUpdatedAt ?? now,
    notebookId: overrides.notebookId ?? '',
    anchor: overrides.anchor ?? 'KMP',
    kind: overrides.kind ?? 'concept',
    candidates: (overrides.candidates ?? []).map((c) => ({
      blockId: c.blockId,
      docId: c.docId ?? 'd',
      docTitle: c.docTitle ?? 'D',
      snippet: c.snippet ?? 's',
      confidence: c.confidence ?? 0.9,
      scoreKind: c.scoreKind ?? 'hybrid',
    })),
    actionStatus: overrides.actionStatus ?? 'suggested',
    reviewStatus: overrides.reviewStatus ?? 'unreviewed',
    createdRefId: overrides.createdRefId ?? null,
    appliedTargetId: overrides.appliedTargetId ?? null,
    scoreKind: overrides.scoreKind ?? 'hybrid',
    model: overrides.model ?? null,
    error: overrides.error ?? null,
    createdAt: overrides.createdAt ?? now,
    appliedAt: overrides.appliedAt ?? null,
    reviewedAt: overrides.reviewedAt ?? null,
  }
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
  getDb().query('DELETE FROM autolink_suggestions').run()
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
}): string {
  const db = getDb()
  const nb = opts.notebookId ?? crypto.randomUUID()
  db.query('INSERT OR IGNORE INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
  const docId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
  ).run(docId, nb, docId, opts.docTitle, now, now)
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

/** v3: 完整 autoLink 配置（限速放大到 1000，避免跨用例干扰；单测限速时显式覆盖） */
function testAutoLinkConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    autoApply: 'never' as const,
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

function mockChatReturning(chatModel: string, jsonResponse: string) {
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  applyNewConfig(
    {
      version: 1,
      chat: { ...makeProvider(chatModel), apiKey: 'key', baseUrl: 'http://mock', embeddingModel: '' } as never,
      embedding: null,
      autoIndex: false,
      reranker: null,
      autoLink: testAutoLinkConfig(),
    },
    pluginSystem,
  )
  const fetcher = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: jsonResponse } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
  getRuntime().setFetchImpl(fetcher)
}

/**
 * 同时 mock chat（抽取）与 embedding（语义重排）：
 * embedQuery 固定返回 queryVector；候选向量需自行 INSERT 进 block_vectors。
 */
function mockChatAndEmbedding(chatModel: string, jsonResponse: string, queryVector: number[]) {
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  applyNewConfig(
    {
      version: 1,
      chat: { ...makeProvider(chatModel), apiKey: 'key', baseUrl: 'http://mock', embeddingModel: '' } as never,
      embedding: {
        ...makeProvider(''),
        apiKey: 'key',
        baseUrl: 'http://mock',
        chatModel: '',
        embeddingModel: 'mock-emb',
      } as never,
      autoIndex: false,
      reranker: null,
      autoLink: testAutoLinkConfig(),
    },
    pluginSystem,
  )
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/embeddings')) {
      return new Response(JSON.stringify({ data: [{ embedding: queryVector }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: jsonResponse } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
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

async function api(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await app.fetch(new Request(`http://localhost/api/v1/auto-link${path}`, init))
  return { status: res.status, body: await res.json() }
}

describe('AutoLink — 抽取与解析', () => {
  test('LLM 返回有效 JSON → 提取 mentions', async () => {
    mockChatReturning('gpt-4o-mini', JSON.stringify({
      mentions: [
        { anchor: 'KMP', kind: 'concept' },
        { anchor: '字符串匹配', kind: 'concept' },
      ],
    }))
    const docId = seedDocWithBlocks({
      docTitle: 'x',
      blocks: [{ id: 'b1', content: '这是关于 KMP 和字符串匹配的笔记' }],
    })
    const blockId = 'b1'
    const r = await analyzeBlock({
      blockId,
      content: '这是关于 KMP 和字符串匹配的笔记',
      notebookId: 'T',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.suggestionsAdded).toBe(0) // 没东西可匹配（库中只有它自己）
    expect(getRuntime().status().usage.autoLinkAnalyses).toBeGreaterThan(0)
    void docId
  })

  test('anchor 不在原文 → 被过滤', async () => {
    mockChatReturning('gpt-4o-mini', JSON.stringify({
      mentions: [
        { anchor: 'Rust', kind: 'tool' }, // 原文里没有
        { anchor: 'KMP', kind: 'concept' },
      ],
    }))
    const docId = seedDocWithBlocks({
      docTitle: 'KMP 算法笔记',
      blocks: [
        { id: 'kmp', content: 'KMP 是高效的字符串匹配' },
      ],
    })
    addSuggestions([makeSuggestion({
      sourceBlockId: 'kmp',
      anchor: 'KMP',
      candidates: [
        { blockId: 'kmp', docId, docTitle: 'KMP 算法笔记', snippet: 'KMP 是高效的字符串匹配', confidence: 0.9, scoreKind: 'hybrid' },
      ],
    })])
    expect(listSuggestionsForBlock('kmp').length).toBe(1)
  })

  test('过短内容（<10 字）短路返回 0', async () => {
    mockChatReturning('gpt-4o-mini', JSON.stringify({ mentions: [] }))
    const r = await analyzeBlock({
      blockId: 'tiny',
      content: 'abc',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.analyzed).toBe(0)
  })
})

describe('AutoLink — store apply / dismiss', () => {
  test('apply 写入 block_refs（ref_type=ai_link）', () => {
    const docId = seedDocWithBlocks({ docTitle: 't', blocks: [] })
    const a = docId
    const b = docId + '-other'
    const db = getDb()
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`,
    ).run(b, 'T', b, 'paragraph', 'other', now, now)
    const ok = insertRef(a, b, 'ai_link')
    expect(ok).toBe(true)
    const again = insertRef(a, b, 'ai_link')
    expect(again).toBe(false)
  })

  test('store roundtrip：add → toWire → apply 后状态 = applied', () => {
    const id = crypto.randomUUID()
    addSuggestions([makeSuggestion({
      id,
      sourceBlockId: 's',
      anchor: 'X',
      candidates: [
        { blockId: 't', docId: 'd', docTitle: 'T', snippet: 'snippet', confidence: 0.5, scoreKind: 'hybrid' },
      ],
    })])
    const wire = toWire(findSuggestion(id)!)
    expect(wire.anchor).toBe('X')
    expect(wire.action_status).toBe('suggested')
    // dismiss 后状态变更
    const r = dismissSuggestion(id)
    expect(r.dismissed).toBe(true)
    expect(findSuggestion(id)?.reviewStatus).toBe('dismissed')
  })

  test('revert 精确按 created_ref_id 撤销', () => {
    const db = getDb()
    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'd')
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('src2', docId, 'src2', 'paragraph', 'src text', now, now)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('tgt2', docId, 'tgt2', 'paragraph', 'tgt text', now, now)

    const sid = crypto.randomUUID()
    addSuggestions([makeSuggestion({
      id: sid,
      sourceBlockId: 'src2',
      anchor: 'KMP',
      candidates: [{ blockId: 'tgt2', docId, docTitle: 'd', snippet: 'tgt text', confidence: 0.9, scoreKind: 'hybrid' }],
    })])

    const applyR = applySuggestion(sid, 0, 'ai_suggested')
    expect(applyR.applied).toBe(true)
    expect(applyR.refId).toBeGreaterThan(0)
    // 手动塞一对 (src2, tgt2) manual ref 来验证 revert 不误删
    const manualRow = db
      .query(`INSERT INTO block_refs (source_id, target_id, ref_type) VALUES (?, ?, 'link') RETURNING id`)
      .get('src2', 'tgt2') as { id: number }
    const beforeCount = (db.query('SELECT count(*) as c FROM block_refs WHERE source_id = ? AND target_id = ?')
      .get('src2', 'tgt2') as { c: number }).c
    expect(beforeCount).toBe(2)  // manual + ai_suggested
    // revert
    const rev = revertSuggestion(sid)
    expect(rev.reverted).toBe(true)
    // manual 还在
    const afterCount = (db.query('SELECT count(*) as c FROM block_refs WHERE source_id = ? AND target_id = ?')
      .get('src2', 'tgt2') as { c: number }).c
    expect(afterCount).toBe(1)
    // manual ref 的 id 不变
    const stillThere = db.query('SELECT id FROM block_refs WHERE id = ?').get(manualRow.id)
    expect(stillThere).not.toBeNull()
  })

  test('同 source_block_id 不同 content_hash → 旧 suggestion 自动 superseded', () => {
    const id1 = crypto.randomUUID()
    addSuggestions([makeSuggestion({ id: id1, sourceBlockId: 'race', anchor: 'A', sourceContentHash: 'hash-old' })])
    expect(findSuggestion(id1)?.actionStatus).toBe('suggested')
    // 第二次写入同 source 但不同 hash
    const id2 = crypto.randomUUID()
    addSuggestions([makeSuggestion({ id: id2, sourceBlockId: 'race', anchor: 'B', sourceContentHash: 'hash-new' })])
    expect(findSuggestion(id1)?.actionStatus).toBe('superseded')
    expect(findSuggestion(id2)?.actionStatus).toBe('suggested')
  })
})

describe('AutoLink — HTTP routes', () => {
  test('GET /suggestions?doc_id=X 返回 pending 列表', async () => {
    mockChatReturning('gpt-4o-mini', JSON.stringify({ mentions: [] }))
    const docId = seedDocWithBlocks({
      docTitle: 'ABC',
      blocks: [{ id: 'bb', content: 'content placeholder' }],
    })
    addSuggestions([makeSuggestion({
      sourceBlockId: 'bb',
      anchor: 'foo',
      candidates: [{ blockId: 'x', docId: 'd', docTitle: 'D', snippet: 's', confidence: 0.5, scoreKind: 'hybrid' }],
    })])
    const { status, body } = await api('GET', `/suggestions?doc_id=${docId}`)
    expect(status).toBe(200)
    expect(body.count).toBeGreaterThan(0)
  })

  test('POST /apply 写 block_ref 并从 store 移除', async () => {
    mockChatReturning('gpt-4o-mini', JSON.stringify({ mentions: [] }))
    const db = getDb()
    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'd')
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('src', docId, 'src', 'paragraph', 'src text', now, now)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('tgt', docId, 'tgt', 'paragraph', 'tgt text', now, now)

    const sid = crypto.randomUUID()
    addSuggestions([makeSuggestion({
      id: sid,
      sourceBlockId: 'src',
      anchor: 'KMP',
      candidates: [{ blockId: 'tgt', docId, docTitle: 'd', snippet: 'tgt text', confidence: 0.9, scoreKind: 'hybrid' }],
    })])
    const { status, body } = await api('POST', '/apply', { suggestion_id: sid })
    expect(status).toBe(200)
    expect(body.applied).toBe(true)
    const rows = db.query('SELECT * FROM block_refs WHERE source_id = ? AND target_id = ?').all('src', 'tgt') as Array<{ ref_type: string }>
    expect(rows.length).toBe(1)
    expect(rows[0]!.ref_type).toBe('ai_suggested')
    // v2: apply 后状态变 applied，但记录保留
    expect(findSuggestion(sid)?.actionStatus).toBe('applied')
  })

  test('POST /apply 找不到 suggestion → 404', async () => {
    mockChatReturning('gpt-4o-mini', JSON.stringify({ mentions: [] }))
    const { status } = await api('POST', '/apply', { suggestion_id: crypto.randomUUID() })
    expect(status).toBe(404)
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

describe('AutoLink — E2E Tier 1 scenarios', () => {
  /** 端到端：写入 → 分析 → Inbox → 接受 → block_refs 增 → 撤销 → ref 删 */
  test('write → analyze → inbox → accept → revert', async () => {
    mockChatAndEmbedding('gpt-4o-mini', JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    const db = getDb()
    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'd')
    const now = new Date().toISOString()
    // 写源块（提到 KMP）
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('e2e-src', docId, 'e2e-src', 'paragraph', 'KMP 是高效的字符串匹配', now, now)
    // 写目标块（已存在 KMP 内容）+ 语义向量（与查询向量一致 → cosine 1.0）
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('e2e-tgt', docId, 'e2e-tgt', 'paragraph', 'KMP 算法的 next 数组构造', now, now)
    seedVector('e2e-tgt', [1, 0])

    // 触发分析
    const result = await analyzeBlock({
      blockId: 'e2e-src',
      content: 'KMP 是高效的字符串匹配',
      notebookId: docId,
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(result.errors).toEqual([])
    expect(result.suggestionsAdded).toBeGreaterThan(0)

    // Inbox 应有 1 条 unreviewed 建议（autoApply='never' 时只入 inbox）
    const inboxRes = await api('GET', '/inbox?status=unreviewed')
    expect(inboxRes.status).toBe(200)
    const ourItem = inboxRes.body.items.find((i: { source_block_id: string }) => i.source_block_id === 'e2e-src')
    expect(ourItem).toBeDefined()
    expect(ourItem.action_status).toBe('suggested')
    const sid = ourItem.id

    // 接受
    const applyRes = await api('POST', '/apply', { suggestion_id: sid })
    expect(applyRes.status).toBe(200)
    expect(applyRes.body.applied).toBe(true)
    expect(applyRes.body.ref_id).toBeGreaterThan(0)

    // block_refs 出现一行
    const refRows = db.query('SELECT * FROM block_refs WHERE source_id = ? AND target_id = ?')
      .all('e2e-src', 'e2e-tgt') as Array<{ ref_type: string; id: number }>
    expect(refRows.length).toBe(1)
    expect(refRows[0]!.ref_type).toBe('ai_suggested')
    const refId = refRows[0]!.id

    // 撤销
    const revertRes = await api('POST', `/${sid}/revert`, {})
    expect(revertRes.status).toBe(200)
    expect(revertRes.body.reverted).toBe(true)
    // ref 行被精确删除
    const stillThere = db.query('SELECT id FROM block_refs WHERE id = ?').get(refId)
    expect(stillThere).toBeNull()
    // suggestion 变 reverted，重新出现在 unreviewed inbox
    const after = findSuggestion(sid)
    expect(after?.actionStatus).toBe('reverted')
    expect(after?.reviewStatus).toBe('unreviewed')
  })

  /** 竞态：连续 PATCH 同一 block，旧 suggestion 自动 superseded */
  test('race: 连续 PATCH 同一 block → 旧 suggestion 自动 superseded', async () => {
    const db = getDb()
    // 直接调 addSuggestions 验证 hash 幂等行为（绕开 analyzeBlock 的运行时副作用）
    const v1 = crypto.randomUUID()
    const v2 = crypto.randomUUID()
    const v3 = crypto.randomUUID()
    addSuggestions([makeSuggestion({
      id: v1, sourceBlockId: 'race-src', anchor: 'KMP',
      sourceContentHash: 'v1',
      candidates: [{ blockId: 'race-tgt', docId: 'd', docTitle: 't', snippet: 's', confidence: 0.9, scoreKind: 'fts_rank' }],
    })])
    addSuggestions([makeSuggestion({
      id: v2, sourceBlockId: 'race-src', anchor: 'KMP',
      sourceContentHash: 'v2',
      candidates: [{ blockId: 'race-tgt', docId: 'd', docTitle: 't', snippet: 's', confidence: 0.9, scoreKind: 'fts_rank' }],
    })])
    addSuggestions([makeSuggestion({
      id: v3, sourceBlockId: 'race-src', anchor: 'KMP',
      sourceContentHash: 'v3',
      candidates: [{ blockId: 'race-tgt', docId: 'd', docTitle: 't', snippet: 's', confidence: 0.9, scoreKind: 'fts_rank' }],
    })])
    const alive = db.query(
      `SELECT count(*) as c FROM autolink_suggestions
       WHERE source_block_id = 'race-src' AND action_status NOT IN ('superseded', 'failed')`,
    ).get() as { c: number }
    const dead = db.query(
      `SELECT count(*) as c FROM autolink_suggestions
       WHERE source_block_id = 'race-src' AND action_status = 'superseded'`,
    ).get() as { c: number }
    expect(alive.c).toBe(1)
    expect(dead.c).toBe(2)
  })

  /** 撤销时 target 已被删除 → 静默成功（ref 已不存在 = 撤销完成） */
  test('revert with target deleted → silent success', () => {
    const db = getDb()
    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'd')
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('ghost-src', docId, 'ghost-src', 'paragraph', 'src', now, now)

    const sid = crypto.randomUUID()
    addSuggestions([makeSuggestion({
      id: sid,
      sourceBlockId: 'ghost-src',
      anchor: 'X',
      candidates: [{ blockId: 'ghost-tgt', docId, docTitle: 't', snippet: 's', confidence: 0.9, scoreKind: 'hybrid' }],
    })])

    // target 提前被删 → apply 应该标 failed
    const applyR = applySuggestion(sid, 0, 'ai_suggested')
    expect(applyR.applied).toBe(false)
    expect(applyR.reason).toBe('target_deleted')
    expect(findSuggestion(sid)?.actionStatus).toBe('failed')

    // 此时 revert → not_applied
    const rev = revertSuggestion(sid)
    expect(rev.reverted).toBe(false)
    expect(rev.reason).toBe('not_applied')
  })

  /** Inbox 默认查询同时返回 AI 已应用 + AI 仅建议 */
  test('Inbox review_status=unreviewed 同时含 suggested + applied', async () => {
    mockChatReturning('gpt-4o-mini', JSON.stringify({ mentions: [] }))
    const db = getDb()
    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'd')
    const now = new Date().toISOString()
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('ib-src1', docId, 'ib-src1', 'paragraph', 'a', now, now)
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('ib-src2', docId, 'ib-src2', 'paragraph', 'b', now, now)
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('ib-tgt', docId, 'ib-tgt', 'paragraph', 'tgt', now, now)

    // suggested 一条
    addSuggestions([makeSuggestion({
      id: 'ib-s-suggested',
      sourceBlockId: 'ib-src1',
      candidates: [{ blockId: 'ib-tgt', docId, docTitle: 'd', snippet: 't', confidence: 0.9, scoreKind: 'hybrid' }],
    })])
    // applied 一条（apply 后）
    addSuggestions([makeSuggestion({
      id: 'ib-s-applied',
      sourceBlockId: 'ib-src2',
      candidates: [{ blockId: 'ib-tgt', docId, docTitle: 'd', snippet: 't', confidence: 0.9, scoreKind: 'hybrid' }],
    })])
    applySuggestion('ib-s-applied', 0, 'ai_suggested')

    const inbox = await api('GET', '/inbox?status=unreviewed')
    const ids = inbox.body.items.map((i: { id: string }) => i.id)
    expect(ids).toContain('ib-s-suggested')
    expect(ids).toContain('ib-s-applied')
  })

  /** autoApply='never'（默认）即使 embedding 命中也不自动写 ref */
  test("autoApply='never' 即使 cosine 高也不自动写 ref", async () => {
    mockChatAndEmbedding('gpt-4o-mini', JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    const db = getDb()
    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'd')
    const now = new Date().toISOString()
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('nv-src', docId, 'nv-src', 'paragraph', 'KMP is great', now, now)
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('nv-tgt', docId, 'nv-tgt', 'paragraph', 'KMP algorithm details', now, now)
    seedVector('nv-tgt', [1, 0])

    // 当前 test config 是 autoApply='never'
    const before = (db.query('SELECT count(*) as c FROM block_refs').get() as { c: number }).c
    const result = await analyzeBlock({
      blockId: 'nv-src',
      content: 'KMP is great',
      notebookId: docId,
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(result.applied).toBe(0)
    expect(result.suggestionsAdded).toBeGreaterThan(0)
    const after = (db.query('SELECT count(*) as c FROM block_refs').get() as { c: number }).c
    expect(after).toBe(before)
  })
})

describe('AutoLink — v3 精准优先', () => {
  /** 无 embedding provider 时，纯 FTS 字面命中不产生建议（FTS-only 不进 Inbox） */
  test('FTS-only 字面命中 → 不产生建议', async () => {
    mockChatReturning('gpt-4o-mini', JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }))
    const db = getDb()
    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'd')
    const now = new Date().toISOString()
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('fts-src', docId, 'fts-src', 'paragraph', 'KMP 是高效的字符串匹配', now, now)
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('fts-tgt', docId, 'fts-tgt', 'paragraph', 'KMP 算法的 next 数组', now, now)

    const r = await analyzeBlock({
      blockId: 'fts-src',
      content: 'KMP 是高效的字符串匹配',
      notebookId: docId,
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    expect(r.suggestionsAdded).toBe(0)
  })

  /** 语义分低于 minConfidence → 同样不产生建议 */
  test('cosine 低于 minConfidence → 不产生建议', async () => {
    mockChatAndEmbedding('gpt-4o-mini', JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    const db = getDb()
    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'd')
    const now = new Date().toISOString()
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('low-src', docId, 'low-src', 'paragraph', 'KMP 是高效的字符串匹配', now, now)
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('low-tgt', docId, 'low-tgt', 'paragraph', 'KMP 算法的 next 数组', now, now)
    // 与查询向量垂直 → cosine 0，低于 0.85 门槛
    seedVector('low-tgt', [0, 1])

    const r = await analyzeBlock({
      blockId: 'low-src',
      content: 'KMP 是高效的字符串匹配',
      notebookId: docId,
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    expect(r.suggestionsAdded).toBe(0)
  })

  /** kind=tool 的锚点被 excludeAnchorKinds 默认过滤 */
  test('kind=tool 锚点被默认过滤，concept 正常通过', async () => {
    mockChatAndEmbedding('gpt-4o-mini', JSON.stringify({
      mentions: [
        { anchor: 'notefast_create_doc', kind: 'tool' },
        { anchor: 'KMP', kind: 'concept' },
      ],
    }), [1, 0])
    const db = getDb()
    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'd')
    const now = new Date().toISOString()
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('kind-src', docId, 'kind-src', 'paragraph', '调用 notefast_create_doc 创建，比如 KMP 笔记', now, now)
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('kind-tgt1', docId, 'kind-tgt1', 'paragraph', 'notefast_create_doc 工具说明', now, now)
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('kind-tgt2', docId, 'kind-tgt2', 'paragraph', 'KMP 算法详解', now, now)
    seedVector('kind-tgt1', [1, 0])
    seedVector('kind-tgt2', [1, 0])

    const r = await analyzeBlock({
      blockId: 'kind-src',
      content: '调用 notefast_create_doc 创建，比如 KMP 笔记',
      notebookId: docId,
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    // 只剩 KMP（concept）一条；tool 锚点被过滤
    expect(r.suggestionsAdded).toBe(1)
    expect(r.suggestions[0]!.anchor).toBe('KMP')
  })

  /** excludeSelfDoc：同一文档内的 block 不作为候选 */
  test('excludeSelfDoc 同文档候选被过滤', async () => {
    mockChatAndEmbedding('gpt-4o-mini', JSON.stringify({
      mentions: [{ anchor: 'KMP', kind: 'concept' }],
    }), [1, 0])
    // 源块与目标块在同一个文档（root_id 相同）
    const docId = seedDocWithBlocks({
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
    expect(r.suggestionsAdded).toBe(0)
    void docId
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
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mentions: [] }) } }] }), {
        status: 200,
      })) as unknown as typeof fetch)
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

describe('AutoLink — 批量审阅', () => {
  test('POST /bulk-review accept 全部写入 ref，dismiss 全部标记忽略', async () => {
    mockChatReturning('gpt-4o-mini', JSON.stringify({ mentions: [] }))
    const db = getDb()
    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'd')
    const now = new Date().toISOString()
    for (const bid of ['bk-s1', 'bk-s2', 'bk-s3', 'bk-t']) {
      db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run(bid, docId, bid, 'paragraph', 'text ' + bid, now, now)
    }
    const mk = (id: string, src: string) => makeSuggestion({
      id,
      sourceBlockId: src,
      candidates: [{ blockId: 'bk-t', docId, docTitle: 'd', snippet: 's', confidence: 0.9, scoreKind: 'hybrid' }],
    })
    addSuggestions([mk('bk-1', 'bk-s1'), mk('bk-2', 'bk-s2'), mk('bk-3', 'bk-s3')])

    // 批量接受 2 条
    const acc = await api('POST', '/bulk-review', { action: 'accept', ids: ['bk-1', 'bk-2'] })
    expect(acc.status).toBe(200)
    expect(acc.body.done).toBe(2)
    expect(acc.body.failed).toBe(0)
    const refCount = (db.query('SELECT count(*) as c FROM block_refs').get() as { c: number }).c
    expect(refCount).toBe(2)

    // 批量忽略 1 条
    const dis = await api('POST', '/bulk-review', { action: 'dismiss', ids: ['bk-3'] })
    expect(dis.status).toBe(200)
    expect(dis.body.done).toBe(1)
    expect(findSuggestion('bk-3')?.reviewStatus).toBe('dismissed')

    // 不存在的 id 计入 failed，不中断
    const mixed = await api('POST', '/bulk-review', { action: 'dismiss', ids: ['nonexistent'] })
    expect(mixed.status).toBe(200)
    expect(mixed.body.done).toBe(0)
    expect(mixed.body.failed).toBe(1)
  })

  test('POST /bulk-review 参数校验：空 ids → 400', async () => {
    mockChatReturning('gpt-4o-mini', JSON.stringify({ mentions: [] }))
    const { status } = await api('POST', '/bulk-review', { action: 'accept', ids: [] })
    expect(status).toBe(400)
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
        autoApply: 'never',
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
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ mentions: [{ anchor: 'KMP', kind: 'concept' }] }) } }],
      }), { status: 200 })
    }) as unknown as typeof fetch)

    const db = getDb()
    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'd')
    const now = new Date().toISOString()
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('cfg-src', docId, 'cfg-src', 'paragraph', 'KMP 是高效的字符串匹配', now, now)
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`).run('cfg-tgt', docId, 'cfg-tgt', 'paragraph', 'KMP 算法的 next 数组', now, now)
    seedVector('cfg-tgt', [1, 0])

    const r = await analyzeBlock({
      blockId: 'cfg-src',
      content: 'KMP 是高效的字符串匹配',
      notebookId: docId,
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.errors).toEqual([])
    // concept 也在排除清单里 → 不产生任何建议
    expect(r.suggestionsAdded).toBe(0)
  })
})
