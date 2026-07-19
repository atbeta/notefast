/**
 * Chat (RAG + SSE) 集成测试
 *
 * 验证：
 * - chat 未配置时返回 not_configured 事件
 * - chat 配置后产生 retrieval → token* → done 事件序列
 * - citations 列表与 done 事件一致
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { initDb, closeDb } from '../db'
import { createPluginSystem } from '@notefast/core'
import {
  initAiRuntime,
  applyNewConfig,
  _setRuntimeForTests,
} from '../services/aiRuntime'
import ai from '../api/ai'
import { runChat } from '../ai/chat'

let testDir: string
let pluginSystem: ReturnType<typeof createPluginSystem>
let app: Hono

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-chat-'))
  initDb(testDir)
  pluginSystem = createPluginSystem()
  app = new Hono()
  app.use('*', cors({ origin: '*' }))
  app.route('/api/v1/ai', ai)
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
})

async function consumeSSE(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const events: Array<{ event: string; data: unknown }> = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let eventName = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (data) {
        try {
          events.push({ event: eventName, data: JSON.parse(data) })
        } catch {
          events.push({ event: eventName, data })
        }
      }
    }
  }
  return events
}

describe('POST /api/v1/ai/chat — 能力缺失', () => {
  test('chat 未配置时 SSE 返回 error 事件', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/v1/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      }),
    )
    expect(res.status).toBe(200)
    const events = await consumeSSE(res)
    const err = events.find((e) => e.event === 'error')
    expect(err).toBeDefined()
    expect((err!.data as { code?: string }).code).toBe('not_configured')
  })
})

describe('POST /api/v1/ai/chat — 流式正常路径', () => {
  test('retrieval → token* → done 事件序列', async () => {
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
        embedding: null,
        autoIndex: false,
        reranker: null,
      },
      pluginSystem,
    )

    // seed FTS 数据
    const { getDb } = await import('../db')
    const db = getDb()
    const nb = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const docId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
    ).run(docId, nb, docId, 'KMP 笔记', now, now)
    const blockId = crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', ?, 0, 1, ?, ?)`,
    ).run(blockId, nb, docId, docId, 'KMP is a string matching algorithm', now, now)

    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"KMP"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" algorithm"}}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const encoder = new TextEncoder()
    const fetcher = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const ch of sseChunks) c.enqueue(encoder.encode(ch))
            c.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl(fetcher)

    const res = await app.fetch(
      new Request('http://localhost/api/v1/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'KMP' }] }),
      }),
    )
    expect(res.status).toBe(200)
    const events = await consumeSSE(res)
    const names = events.map((e) => e.event)
    // 期望：retrieval → 多 token → done
    expect(names[0]).toBe('retrieval')
    expect(names[names.length - 1]).toBe('done')
    const tokens = events.filter((e) => e.event === 'token').map((e) => (e.data as { content: string }).content)
    expect(tokens.join('')).toContain('KMP')
    const done = events.find((e) => e.event === 'done')
    expect(done).toBeDefined()
    expect((done!.data as { citations: unknown[] }).citations.length).toBeGreaterThan(0)
  })

  test('runChat() 未配置时返回 error 事件', async () => {
    _setRuntimeForTests(null)
    initAiRuntime(pluginSystem, testDir)
    const events: string[] = []
    for await (const ev of runChat({ messages: [{ role: 'user', content: 'q' }] })) {
      events.push(ev.type)
    }
    expect(events).toEqual(['error'])
  })

  /**
   * Agent loop：mock LLM 第一次返回 tool_call，第二次返回 final answer。
   * 验证：tool 事件触发 + 后续工具结果回填 + done 事件含 toolTrace。
   */
  test('agent loop: LLM 调用 notefast_search_more 后给出最终答案', async () => {
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
        embedding: null,
        autoIndex: false,
        reranker: null,
      },
      pluginSystem,
    )

    // chatWithTools 用 JSON 响应（不走 SSE）
    let callCount = 0
    const fetcher: typeof fetch = (async () => {
      callCount++
      if (callCount === 1) {
        // 第一轮：请求搜索更多
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'notefast_search_more',
                    arguments: JSON.stringify({ query: 'detailed' }),
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ) as unknown as Response
      }
      // 第二轮：最终答案
      return new Response(
        JSON.stringify({
          choices: [{
            message: { role: 'assistant', content: 'final answer based on deeper search' },
            finish_reason: 'stop',
          }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as unknown as Response
    }) as unknown as typeof fetch
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl(fetcher)

    const events: Array<{ type: string; payload?: unknown }> = []
    for await (const ev of runChat({ messages: [{ role: 'user', content: 'tell me about KMP' }] })) {
      events.push({ type: ev.type, payload: ev })
    }
    const types = events.map((e) => e.type)
    expect(types).toContain('retrieval')
    expect(types).toContain('tool')
    expect(types[types.length - 1]).toBe('done')
    const toolEvent = events.find((e) => e.type === 'tool') as { type: string; payload?: { tool: string; resultCount: number } }
    expect(toolEvent.payload?.tool).toBe('notefast_search_more')
    const doneEvent = events.find((e) => e.type === 'done') as { type: string; payload?: { toolTrace: Array<{ tool: string }> } }
    expect(doneEvent.payload?.toolTrace.length).toBeGreaterThan(0)
    expect(doneEvent.payload?.toolTrace[0]?.tool).toBe('notefast_search_more')
    // 至少调用过 2 次 LLM
    expect(callCount).toBeGreaterThanOrEqual(2)
  })

  /**
   * Time-window filter：since/until 限制返回的 blocks
   */
  test('hybridSearch since/until 时间窗过滤', async () => {
    const { getDb, initDb } = await import('../db')
    initDb(testDir)
    const db = getDb()
    const { hybridSearch } = await import('../ai/hybridSearch')

    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'd')
    const old = '2020-01-01T00:00:00.000Z'
    const recent = '2026-01-01T00:00:00.000Z'
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('old-block', docId, 'old-block', 'paragraph', 'KMP 算法（旧）', old, old)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('new-block', docId, 'new-block', 'paragraph', 'KMP 算法（新）', recent, recent)
    // FTS5 重建（hybridSearch 内部依赖 fts5 触发器，但显式 rebuild 更稳）
    db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")

    const sinceReport = await hybridSearch({ query: 'KMP', since: '2025-01-01T00:00:00.000Z' })
    expect(sinceReport.citations.every((c) => c.block_id !== 'old-block')).toBe(true)
    expect(sinceReport.citations.some((c) => c.block_id === 'new-block')).toBe(true)

    const untilReport = await hybridSearch({ query: 'KMP', until: '2021-01-01T00:00:00.000Z' })
    expect(untilReport.citations.some((c) => c.block_id === 'old-block')).toBe(true)
    expect(untilReport.citations.every((c) => c.block_id !== 'new-block')).toBe(true)
  })
})
