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
import { initDb, closeDb, getDb } from '../db'
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
})

/** 技能审计用：让 LLM 先调一个工具，再捕获回填给第二轮的 body。 */
async function captureToolResultBody(tool: string, args: Record<string, unknown>, user: string): Promise<string> {
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
  let secondCallBody = ''
  let callCount = 0
  const encoder = new TextEncoder()
  const sseResponse = (chunks: string[]) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(encoder.encode(ch))
          c.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  const argsJson = JSON.stringify(JSON.stringify(args))
  const fetcher: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    callCount++
    if (callCount === 1) {
      return sseResponse([
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"${tool}","arguments":""}}]}}]}\n\n`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":${argsJson}}}]}}]}\n\n`,
        'data: [DONE]\n\n',
      ]) as unknown as Response
    }
    secondCallBody = String(init?.body ?? '')
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ]) as unknown as Response
  }) as unknown as typeof fetch
  const { getRuntime } = await import('../services/aiRuntime')
  getRuntime().setFetchImpl(withQueryUnderstandingStub(fetcher))
  for await (const _ev of runChat({ messages: [{ role: 'user', content: user }] })) {
    /* drain */
  }
  return secondCallBody
}

function seedListedDoc(id: string, title: string, status: string, updatedAt: string) {
  const db = getDb()
  const nb = crypto.randomUUID()
  db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, status, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, ?, 0, 0, ?, ?)`,
  ).run(id, nb, id, title, status, updatedAt, updatedAt)
}

/**
 * chat 首检索会先打一枪非流式 json_object（queryUnderstanding）。
 * 测试 mock 若一律回 SSE，会污染 callCount / 解析失败。此包装拦截理解请求，不计入 inner。
 */
function withQueryUnderstandingStub(inner: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let body: {
      response_format?: { type?: string }
      stream?: boolean
      messages?: Array<{ content?: unknown }>
    } | null = null
    try {
      if (init?.body) body = JSON.parse(String(init.body))
    } catch { /* ignore */ }
    if (body?.response_format?.type === 'json_object' && body.stream !== true) {
      const last = body.messages?.at(-1)?.content
      const q = (typeof last === 'string' ? last : 'query').trim().slice(0, 40) || 'query'
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({ terms: [[q]], rewritten: q }),
            },
          }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return inner(input, init)
  }) as unknown as typeof fetch
}

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
    getRuntime().setFetchImpl(withQueryUnderstandingStub(fetcher))

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
   * Agent loop：mock LLM 第一次 SSE 返回 tool_call，第二次 SSE 返回 final answer。
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

    let callCount = 0
    const encoder = new TextEncoder()
    const sseResponse = (chunks: string[]) =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const ch of chunks) c.enqueue(encoder.encode(ch))
            c.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )

    const fetcher: typeof fetch = (async () => {
      callCount++
      if (callCount === 1) {
        return sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"notefast_search_more","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":\\"detailed\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]) as unknown as Response
      }
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"final answer based on deeper search"}}]}\n\n',
        'data: [DONE]\n\n',
      ]) as unknown as Response
    }) as unknown as typeof fetch
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl(withQueryUnderstandingStub(fetcher))

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
    const tokens = events.filter((e) => e.type === 'token') as Array<{ payload?: { content: string } }>
    expect(tokens.map((t) => t.payload?.content).join('')).toContain('final answer')
    expect(callCount).toBeGreaterThanOrEqual(2)
  })

  test('流式 reasoning 事件与 think 标签拆分', async () => {
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

    const encoder = new TextEncoder()
    const fetcher = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"step1"}}]}\n\n'))
            c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"<think>inner"}}]}\n\n'))
            c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"</think>\\nAnswer"}}]}\n\n'))
            c.enqueue(encoder.encode('data: [DONE]\n\n'))
            c.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl(withQueryUnderstandingStub(fetcher))

    const reasoning: string[] = []
    const tokens: string[] = []
    for await (const ev of runChat({
      messages: [{ role: 'user', content: 'hi' }],
      enableTools: false,
    })) {
      if (ev.type === 'reasoning') reasoning.push(ev.content)
      if (ev.type === 'token') tokens.push(ev.content)
    }
    expect(reasoning.join('')).toContain('step1')
    expect(reasoning.join('')).toContain('inner')
    expect(tokens.join('')).toContain('Answer')
    expect(tokens.join('')).not.toContain('<think>')
  })

  /**
   * 写工具在 chat agent loop 中直接执行（确认卡片流程已废弃）：
   * - agent loop 直接 yield tool 事件并真正写库（不再发 write_proposal 提案）
   * - 写库触发 afterCreate hooks（doc 先、子块批量，保证自动索引与 doc 变更广播）
   * - 回退保障：block_revisions / doc_snapshots 历史（POST /blocks/:id/revisions/:rev/restore）
   */
  test('agent loop: 写工具直接执行并写库（无确认提案）', async () => {
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

    let callCount = 0
    const encoder = new TextEncoder()
    const sseResponse = (chunks: string[]) =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const ch of chunks) c.enqueue(encoder.encode(ch))
            c.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )

    const fetcher: typeof fetch = (async () => {
      callCount++
      if (callCount === 1) {
        return sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"notefast_create_note","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"title\\":\\"聊天建的笔记\\",\\"markdown\\":\\"## 章节\\\\n\\\\n正文内容\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]) as unknown as Response
      }
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"已提交待确认"}}]}\n\n',
        'data: [DONE]\n\n',
      ]) as unknown as Response
    }) as unknown as typeof fetch
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl(withQueryUnderstandingStub(fetcher))

    const created: Array<{ type: string; content: string }> = []
    pluginSystem.note.afterCreate.tap('test-create-note-spy', (block) => {
      created.push({ type: block.type, content: block.content })
    })
    try {
      const events: string[] = []
      for await (const ev of runChat({ messages: [{ role: 'user', content: '记一下' }] })) {
        events.push(ev.type)
      }
      // 写工具 → 直接执行（tool 事件），而不是提案事件
      expect(events).toContain('tool')
      expect(events).not.toContain('write_proposal')
      // agent loop 直接写库：afterCreate 已触发
      const docBlock = created.find((b) => b.type === 'document')
      expect(docBlock?.content).toBe('聊天建的笔记')
      expect(created.some((b) => b.type === 'heading' && b.content === '章节')).toBe(true)
      expect(created.some((b) => b.type === 'paragraph' && b.content === '正文内容')).toBe(true)
    } finally {
      pluginSystem.note.afterCreate.untap('test-create-note-spy')
    }
  })

  /**
   * notefast_list_docs：skills（整理收集箱/归档建议/周期回顾）依赖的列表工具。
   * 验证 status 过滤生效且结果回填进下一轮 LLM 请求。
   */
  test('agent loop: notefast_list_docs 按 status 过滤并回填结果', async () => {
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

    // seed：一篇正式笔记 + 一篇收集箱
    const { getDb } = await import('../db')
    const db = getDb()
    const nb = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const now = new Date().toISOString()
    for (const [id, title, st] of [
      ['ld-note', '正式笔记ZZZ', 'note'],
      ['ld-inbox', '收集箱素材ZZZ', 'inbox'],
    ] as const) {
      db.query(
        `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, status, sort, level, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'document', ?, ?, 0, 0, ?, ?)`,
      ).run(id, nb, id, title, st, now, now)
    }

    let callCount = 0
    let secondCallBody = ''
    const encoder = new TextEncoder()
    const sseResponse = (chunks: string[]) =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const ch of chunks) c.enqueue(encoder.encode(ch))
            c.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )

    const fetcher: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++
      if (callCount === 1) {
        return sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"notefast_list_docs","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"status\\":\\"inbox\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]) as unknown as Response
      }
      secondCallBody = String(init?.body ?? '')
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"收集箱里有 1 篇"}}]}\n\n',
        'data: [DONE]\n\n',
      ]) as unknown as Response
    }) as unknown as typeof fetch
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl(withQueryUnderstandingStub(fetcher))

    const events: Array<{ type: string; payload?: unknown }> = []
    for await (const ev of runChat({ messages: [{ role: 'user', content: '收集箱里有什么' }] })) {
      events.push({ type: ev.type, payload: ev })
    }
    const toolEvent = events.find((e) => e.type === 'tool') as { payload?: { tool: string } }
    expect(toolEvent.payload?.tool).toBe('notefast_list_docs')

    // 工具结果回填：含收集箱文档、不含正式笔记
    expect(secondCallBody).toContain('收集箱素材ZZZ')
    expect(secondCallBody).not.toContain('正式笔记ZZZ')
  })

  /**
   * 非法 status（模型漏枚举约束，如传中文）必须显式报错而非静默返回空列表——
   * 空列表会让模型误判「收集箱为空」（skill「整理收集箱」误报空的根因）。
   */
  test('agent loop: notefast_list_docs 非法 status 返回纠错提示', async () => {
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

    let callCount = 0
    let secondCallBody = ''
    const encoder = new TextEncoder()
    const sseResponse = (chunks: string[]) =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const ch of chunks) c.enqueue(encoder.encode(ch))
            c.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )

    const fetcher: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++
      if (callCount === 1) {
        return sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"notefast_list_docs","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"status\\":\\"收集箱\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]) as unknown as Response
      }
      secondCallBody = String(init?.body ?? '')
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"明白了，我重新传 status=inbox"}}]}\n\n',
        'data: [DONE]\n\n',
      ]) as unknown as Response
    }) as unknown as typeof fetch
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl(withQueryUnderstandingStub(fetcher))

    const events: Array<{ type: string }> = []
    for await (const ev of runChat({ messages: [{ role: 'user', content: '整理收集箱' }] })) {
      events.push({ type: ev.type })
    }

    // 纠错提示回填给模型（含合法值与 inbox 指引），而不是空列表
    expect(secondCallBody).toContain('无效的 status')
    expect(secondCallBody).toContain('inbox')
  })

  test('agent loop: notefast_list_docs stale_within=30d 只返回过时文档', async () => {
    const now = new Date().toISOString()
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    seedListedDoc('stale-fresh', '新笔记STALE', 'note', now)
    seedListedDoc('stale-old', '过时笔记STALE', 'note', old)

    const body = await captureToolResultBody(
      'notefast_list_docs',
      { status: 'note', stale_within: '30d' },
      '归档建议',
    )
    expect(body).toContain('过时笔记STALE')
    expect(body).not.toContain('新笔记STALE')
  })

  test('agent loop: notefast_list_docs updated_within=7d 只返回最近更新', async () => {
    const now = new Date().toISOString()
    const older = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    seedListedDoc('upd-recent', '本周笔记UPD', 'note', now)
    seedListedDoc('upd-old', '更早笔记UPD', 'inbox', older)

    const body = await captureToolResultBody(
      'notefast_list_docs',
      { status: 'all', updated_within: '7d' },
      '周期回顾',
    )
    expect(body).toContain('本周笔记UPD')
    expect(body).not.toContain('更早笔记UPD')
  })

  test('agent loop: notefast_list_docs 非法 stale_within 返回纠错提示', async () => {
    const body = await captureToolResultBody(
      'notefast_list_docs',
      { stale_within: '一个月' },
      '归档建议',
    )
    expect(body).toContain('无效的 stale_within')
    expect(body).toContain('30d')
  })

  test('agent loop: notefast_search_more 非法 since 返回纠错提示', async () => {
    const body = await captureToolResultBody(
      'notefast_search_more',
      { query: '笔记', since: '7d' },
      '周期回顾',
    )
    expect(body).toContain('无效的 since')
    expect(body).toContain('ISO')
  })

  /** 多模态消息：图片段原样透传给模型，文本段用于检索（不报 no_user_message） */
  test('带图片的 user 消息：文本段参与检索，图片段透传', async () => {
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
        vision: { enabled: true },
      },
      pluginSystem,
    )

    let firstCallBody = ''
    const encoder = new TextEncoder()
    const fetcher: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      firstCallBody = String(init?.body ?? '')
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"这是一张架构图"}}]}\n\n'))
            c.enqueue(encoder.encode('data: [DONE]\n\n'))
            c.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ) as unknown as Response
    }) as unknown as typeof fetch
    const { getRuntime } = await import('../services/aiRuntime')
    getRuntime().setFetchImpl(withQueryUnderstandingStub(fetcher))

    const events: string[] = []
    for await (const ev of runChat({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图讲了什么' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
          ],
        },
      ],
    })) {
      events.push(ev.type)
    }

    expect(events).not.toContain('error')
    expect(events).toContain('done')
    // 多模态结构原样透传给 provider
    expect(firstCallBody).toContain('image_url')
    expect(firstCallBody).toContain('data:image/png;base64,QUJD')
    expect(firstCallBody).toContain('这张图讲了什么')
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

describe('executeWriteTool — AI 写入在文档历史中可识别（actor=ai）', () => {
  function seedDoc(db: ReturnType<typeof getDb>): { docId: string; blockId: string } {
    const docId = crypto.randomUUID()
    const blockId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'd')
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
    ).run(docId, docId, docId, 'AI 测试文档', now, now)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', '原始内容', 0, 0, ?, ?)`,
    ).run(blockId, docId, docId, docId, now, now)
    return { docId, blockId }
  }

  test('update_block：block revision actor 记为 ai（历史面板显示「AI 写入」）', async () => {
    const { getDb } = await import('../db')
    const db = getDb()
    const { blockId } = seedDoc(db)

    const { executeWriteTool } = await import('../ai/chat')
    const res = await executeWriteTool('notefast_update_block', { block_id: blockId, content: 'AI 改写的内容' }, {})
    expect(res.resultCount).toBe(1)

    const rev = db.query(
      `SELECT actor FROM block_revisions WHERE block_id = ? ORDER BY rev DESC LIMIT 1`,
    ).get(blockId) as { actor: string } | undefined
    expect(rev?.actor).toBe('ai')
  })

  test('append_to_doc：追加前记 doc 整篇快照，actor 记为 ai', async () => {
    const { getDb } = await import('../db')
    const db = getDb()
    const { docId } = seedDoc(db)

    const { executeWriteTool } = await import('../ai/chat')
    const res = await executeWriteTool('notefast_append_to_doc', { doc_id: docId, content: 'AI 追加的内容' }, {})
    expect(res.resultCount).toBe(1)

    const snap = db.query(
      `SELECT actor FROM doc_snapshots WHERE doc_id = ? ORDER BY rev DESC LIMIT 1`,
    ).get(docId) as { actor: string } | undefined
    expect(snap?.actor).toBe('ai')
  })

  test('create_note：YAML tags 不入库；显式 tags 才打标', async () => {
    const { executeWriteTool } = await import('../ai/chat')
    const { getDb } = await import('../db')
    const { getBlockById } = await import('../store/blocks')
    const { readTags } = await import('@notefast/core')
    const yaml = '---\ntags:\n  - invented\n---\n\n正文'

    const noTags = await executeWriteTool(
      'notefast_create_note',
      { title: '无指定', markdown: yaml },
      {},
    )
    expect(noTags.resultCount).toBe(1)
    const noId = (JSON.parse(noTags.content) as { doc_id: string }).doc_id
    expect(readTags(getBlockById(getDb(), noId)!)).toEqual([])

    const withTags = await executeWriteTool(
      'notefast_create_note',
      { title: '指定', markdown: yaml, tags: ['work'] },
      {},
    )
    expect(withTags.resultCount).toBe(1)
    const withId = (JSON.parse(withTags.content) as { doc_id: string }).doc_id
    expect(readTags(getBlockById(getDb(), withId)!)).toEqual(['work'])
  })

  test('pin_view / unpin_view', async () => {
    const { executeWriteTool } = await import('../ai/chat')
    const pin = await executeWriteTool('notefast_pin_view', { name: '工作', tags: ['work'] }, {})
    expect(pin.resultCount).toBe(1)
    const parsed = JSON.parse(pin.content) as { id: string; query: string; created: boolean }
    expect(parsed.query).toBe('tags=work')
    expect(parsed.created).toBe(true)

    const dup = await executeWriteTool('notefast_pin_view', { name: '工作2', query: 'tags=work' }, {})
    expect(dup.resultCount).toBe(1)
    expect((JSON.parse(dup.content) as { created: boolean }).created).toBe(false)

    const un = await executeWriteTool('notefast_unpin_view', { id: parsed.id }, {})
    expect(un.resultCount).toBe(1)
  })
})
