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
        active: {
          id: 'x',
          label: 'x',
          preset: 'custom',
          baseUrl: 'http://mock',
          apiKey: '',
          embeddingModel: '', // 关闭 embedding → 只走 FTS5
          chatModel: 'fake-chat',
          timeoutMs: 5000,
          extraHeaders: {},
        },
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
})
