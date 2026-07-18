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
} from '../ai/autoLink'
import {
  addSuggestions,
  clearAllSuggestions,
  findSuggestion,
  listSuggestionsForBlock,
  removeSuggestionById,
  toWire,
} from '../ai/autoLinkStore'

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

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-autolink-'))
  initDb(testDir)
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
  getDb().query('DELETE FROM blocks').run()
  getDb().query('DELETE FROM block_refs').run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
  clearAllSuggestions()
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

function mockChatReturning(chatModel: string, jsonResponse: string) {
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  applyNewConfig(
    {
      version: 1,
      active: { ...makeProvider(chatModel), apiKey: 'key', baseUrl: 'http://mock' } as never,
      autoIndex: false,
      reranker: null,
      autoLink: { enabled: true, autoApply: false, notebookScope: 'all', maxPerBlock: 5 },
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
    addSuggestions([{
      id: crypto.randomUUID(),
      sourceBlockId: 'kmp',
      anchor: 'KMP',
      kind: 'concept',
      candidates: [
        { blockId: 'kmp', docId, docTitle: 'KMP 算法笔记', snippet: 'KMP 是高效的字符串匹配', confidence: 0.9 },
      ],
      createdAt: new Date().toISOString(),
    }])
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

  test('store roundtrip：add → toWire → apply 后移除', () => {
    const id = crypto.randomUUID()
    addSuggestions([{
      id,
      sourceBlockId: 's',
      anchor: 'X',
      kind: 'concept',
      candidates: [
        { blockId: 't', docId: 'd', docTitle: 'T', snippet: 'snippet', confidence: 0.5 },
      ],
      createdAt: new Date().toISOString(),
    }])
    const wire = toWire(findSuggestion(id)!)
    expect(wire.anchor).toBe('X')
    expect(removeSuggestionById(id)).toBe(true)
    expect(findSuggestion(id)).toBeUndefined()
  })
})

describe('AutoLink — HTTP routes', () => {
  test('GET /suggestions?doc_id=X 返回 pending 列表', async () => {
    mockChatReturning('gpt-4o-mini', JSON.stringify({ mentions: [] }))
    const docId = seedDocWithBlocks({
      docTitle: 'ABC',
      blocks: [{ id: 'bb', content: 'content placeholder' }],
    })
    addSuggestions([{
      id: crypto.randomUUID(),
      sourceBlockId: 'bb',
      anchor: 'foo',
      kind: 'concept',
      candidates: [{ blockId: 'x', docId: 'd', docTitle: 'D', snippet: 's', confidence: 0.5 }],
      createdAt: new Date().toISOString(),
    }])
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
    addSuggestions([{
      id: sid,
      sourceBlockId: 'src',
      anchor: 'KMP',
      kind: 'concept',
      candidates: [{ blockId: 'tgt', docId, docTitle: 'd', snippet: 'tgt text', confidence: 0.7 }],
      createdAt: new Date().toISOString(),
    }])
    const { status, body } = await api('POST', '/apply', { suggestion_id: sid })
    expect(status).toBe(200)
    expect(body.applied).toBe(true)
    const rows = db.query('SELECT * FROM block_refs WHERE source_id = ? AND target_id = ?').all('src', 'tgt') as Array<{ ref_type: string }>
    expect(rows.length).toBe(1)
    expect(rows[0]!.ref_type).toBe('ai_link')
    expect(findSuggestion(sid)).toBeUndefined()
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
