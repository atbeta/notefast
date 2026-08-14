import { describe, test, expect } from 'bun:test'
import {
  AiRuntime,
  parseLlmJson,
  type AiRuntimeOptions,
} from '../ai/runtime'
import { makeProviderLike } from './helpers'
import { emptyConfig } from '../ai/config'
import type { AiConfig, ProviderDefinition } from '../ai/config'

function makeRuntime(cfg: AiConfig, fetchImpl?: typeof fetch, batchSize?: number): AiRuntime {
  const opts: AiRuntimeOptions = {}
  if (fetchImpl) opts.fetchImpl = fetchImpl
  if (batchSize) opts.embeddingBatchSize = batchSize
  return new AiRuntime(cfg, opts)
}

function mockFetchJson(status: number, body: unknown): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

function makeFullConfig(overrides: Partial<ProviderDefinition> = {}): AiConfig {
  return {
    version: 1,
    chat: { ...makeProviderLike(overrides), embeddingModel: '' },
    embedding: { ...makeProviderLike(overrides), id: (overrides.id || 'test-provider') + '-emb', chatModel: '' },
    autoIndex: true,
    reranker: null,
  }
}

function makeEmbConfig(overrides: Partial<ProviderDefinition> = {}): AiConfig {
  // 仅 embedding provider；chat 为 null → 不会启用 chat
  return {
    version: 1,
    chat: null,
    embedding: makeProviderLike({ chatModel: '', ...overrides }),
    autoIndex: true,
    reranker: null,
  }
}

describe('AiRuntime 基础状态', () => {
  test('空配置 → disabled', () => {
    const r = makeRuntime(emptyConfig())
    const s = r.status()
    expect(s.enabled).toBe(false)
    expect(s.embedding.configured).toBe(false)
    expect(s.chat.configured).toBe(false)
  })

  test('只配 embedding（chat=null）', () => {
    const r = makeRuntime(makeEmbConfig())
    const s = r.status()
    expect(s.enabled).toBe(true) // 至少 embedding 配了
    expect(s.embedding.configured).toBe(true)
    expect(s.chat.configured).toBe(false)
    expect(r.hasEmbedding()).toBe(true)
    expect(r.hasChat()).toBe(false)
  })

  test('status 暴露脱敏后的 apiKey（chat + embedding 都有）', () => {
    const r = makeRuntime({
      ...makeFullConfig({ apiKey: 'sk-verylongsecret1234' }),
      embedding: makeProviderLike({ apiKey: 'sk-anothersecret67890' }),
    })
    const s = r.status()
    expect(s.config.chat).not.toBeNull()
    expect(s.config.chat!.apiKey).toBe('***set***')
    expect(s.config.embedding!.apiKey).toBe('***set***')
  })
})

describe('AiRuntime reload', () => {
  test('从 enabled 切换到 disabled 立即生效', () => {
    const r = makeRuntime(makeFullConfig())
    expect(r.hasEmbedding()).toBe(true)
    r.reload(emptyConfig())
    expect(r.hasEmbedding()).toBe(false)
    expect(r.status().enabled).toBe(false)
  })

  test('provider enabled=false：不构建 provider，状态等同未配置但配置保留', () => {
    const r = makeRuntime(makeFullConfig({ enabled: false }))
    expect(r.hasChat()).toBe(false)
    expect(r.hasEmbedding()).toBe(false)
    const s = r.status()
    expect(s.enabled).toBe(false)
    expect(s.chat.configured).toBe(false)
    expect(s.embedding.configured).toBe(false)
    expect(r.capabilities().ai_enabled).toBe(false)
    // 配置仍保留在脱敏视图中（UI 回填表单、可再次启用）
    expect(s.config.chat).not.toBeNull()
    expect(s.config.embedding).not.toBeNull()
  })

  test('缺省 enabled（旧配置）视为启用', () => {
    const r = makeRuntime(makeFullConfig())
    expect(r.hasChat()).toBe(true)
    expect(r.hasEmbedding()).toBe(true)
    expect(r.capabilities().ai_enabled).toBe(true)
  })

  test('reload 从启用切到停用立即生效', () => {
    const r = makeRuntime(makeFullConfig())
    expect(r.hasChat()).toBe(true)
    r.reload(makeFullConfig({ enabled: false }), { silent: true })
    expect(r.hasChat()).toBe(false)
    expect(r.hasEmbedding()).toBe(false)
  })

  test('reload 清空旧的 lastError', async () => {
    const failFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const r = makeRuntime(makeFullConfig(), failFetch)
    // 触发一次失败
    r.embedQuery('x').catch(() => {})
    // 等待微任务
    await new Promise((r) => setTimeout(r, 10))
    r.reload(makeFullConfig())
    expect(r.status().embedding.lastError).toBeUndefined()
  })
})

describe('AiRuntime embedQuery', () => {
  test('未启用时返回 null', async () => {
    const r = makeRuntime(emptyConfig())
    expect(await r.embedQuery('x')).toBeNull()
  })

  test('独立 embedding provider：使用 embedding.baseUrl', async () => {
    const fakeVec = Array.from({ length: 4 }, (_, i) => i + 1)
    let hitUrl = ''
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      hitUrl = String(input)
      return new Response(JSON.stringify({ data: [{ embedding: fakeVec }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const r = makeRuntime(
      {
        version: 1,
        chat: makeProviderLike({ baseUrl: 'https://chat.example.com/v1', apiKey: '' }),
        embedding: makeProviderLike({ baseUrl: 'https://emb.example.com/v1' }),
        autoIndex: true,
        reranker: null,
      },
      fetchImpl,
    )
    const v = await r.embedQuery('hi')
    expect(v).not.toBeNull()
    expect(v!.length).toBe(4)
    expect(hitUrl).toContain('emb.example.com')
    expect(hitUrl).not.toContain('chat.example.com')
    expect(r.status().usage.embeddingCalls).toBe(1)
  })

  test('成功时 usage 计数 +1，dim 被记录', async () => {
    const fakeVec = Array.from({ length: 4 }, (_, i) => i + 1)
    const fetchImpl = mockFetchJson(200, { data: [{ embedding: fakeVec }] })
    const r = makeRuntime(makeEmbConfig(), fetchImpl)
    const v = await r.embedQuery('hi')
    expect(v).not.toBeNull()
    expect(v!.length).toBe(4)
    expect(r.status().usage.embeddingCalls).toBe(1)
    expect(r.status().embedding.dim).toBe(4)
    expect(r.status().embedding.lastError).toBeUndefined()
  })

  test('失败时 embeddingErrors +1 且 lastError 被记录', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 401 })) as unknown as typeof fetch
    const r = makeRuntime(makeEmbConfig(), fetchImpl)
    await expect(r.embedQuery('x')).rejects.toThrow()
    expect(r.status().usage.embeddingErrors).toBe(1)
    expect(r.status().embedding.lastError).toContain('401')
  })

  test('兼容本地服务顶层 embeddings[] 格式（Ollama /api/embed 风格）', async () => {
    const fakeVec = Array.from({ length: 3 }, (_, i) => i + 1)
    const fetchImpl = mockFetchJson(200, { model: 'nomic-embed-text', embeddings: [fakeVec] })
    const r = makeRuntime(makeEmbConfig(), fetchImpl)
    const v = await r.embedQuery('hi')
    expect(v).not.toBeNull()
    expect(v!.length).toBe(3)
    expect(r.status().embedding.lastError).toBeUndefined()
  })

  test('响应缺少 data/embeddings → 抛出明确错误（不再 TypeError 或静默空向量）', async () => {
    const fetchImpl = mockFetchJson(200, {})
    const r = makeRuntime(makeEmbConfig(), fetchImpl)
    await expect(r.embedQuery('hi')).rejects.toThrow(/返回空/)
    expect(r.status().embedding.lastError).toContain('返回空')
  })

  test('data 为空数组 → 抛出明确错误', async () => {
    const fetchImpl = mockFetchJson(200, { data: [] })
    const r = makeRuntime(makeEmbConfig(), fetchImpl)
    await expect(r.embedQuery('hi')).rejects.toThrow(/返回空/)
  })

  test('base64 编码向量 → 抛出明确错误（new Float64Array(字符串) 会静默产生全 0 向量）', async () => {
    const fetchImpl = mockFetchJson(200, { data: [{ embedding: 'aGVsbG8=' }] })
    const r = makeRuntime(makeEmbConfig(), fetchImpl)
    await expect(r.embedQuery('hi')).rejects.toThrow(/base64/)
  })

  test('空向量 [] → 抛出明确错误', async () => {
    const fetchImpl = mockFetchJson(200, { data: [{ embedding: [] }] })
    const r = makeRuntime(makeEmbConfig(), fetchImpl)
    await expect(r.embedQuery('hi')).rejects.toThrow(/向量为空/)
  })

  test('返回条数不足 → 抛出数量不匹配错误', async () => {
    const fetchImpl = mockFetchJson(200, { data: [{ embedding: [1, 2, 3] }] })
    // 批量请求 2 条，服务只回 1 条
    const r = makeRuntime(makeEmbConfig(), fetchImpl)
    await expect(r.embedBatch(['a', 'b'])).rejects.toThrow(/数量不足/)
  })
})

describe('AiRuntime chat', () => {
  test('未启用 chat 时抛错（chat=null）', async () => {
    const r = makeRuntime(makeEmbConfig())
    await expect(r.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('not configured')
  })

  test('成功时解析 content 并累计 usage', async () => {
    const fetchImpl = mockFetchJson(200, {
      choices: [{ message: { content: 'pong' } }],
    })
    const r = makeRuntime(makeFullConfig(), fetchImpl)
    const reply = await r.chat([{ role: 'user', content: 'ping' }])
    expect(reply).toBe('pong')
    expect(r.status().usage.chatCalls).toBe(1)
  })

  test('独立 chat provider：使用 chat.baseUrl（不去碰 embedding）', async () => {
    let chatHit = 0
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/chat/completions')) chatHit++
      if (url.includes('/embeddings')) {
        return new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), {
          status: 200,
        })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    const r = makeRuntime(
      {
        version: 1,
        chat: makeProviderLike({ baseUrl: 'https://chat.example.com/v1' }),
        embedding: makeProviderLike({ baseUrl: 'https://emb.example.com/v1' }),
        autoIndex: true,
        reranker: null,
      },
      fetchImpl,
    )
    await r.chat([{ role: 'user', content: 'hi' }])
    expect(chatHit).toBe(1)
  })

  test('失败时记录 chatLastError', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    const r = makeRuntime(makeFullConfig(), fetchImpl)
    await expect(r.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow()
    expect(r.status().chat.lastError).toContain('403')
    expect(r.status().usage.chatErrors).toBe(1)
  })
})

describe('AiRuntime testChat', () => {
  test('未启用时返回 ok=false', async () => {
    const r = makeRuntime(emptyConfig())
    const res = await r.testChat()
    expect(res.ok).toBe(false)
    expect(res.message).toContain('未配置')
  })

  test('连通正常时返回 ok=true', async () => {
    const fetchImpl = mockFetchJson(200, {
      choices: [{ message: { content: 'pongpong' } }],
    })
    const r = makeRuntime(makeFullConfig(), fetchImpl)
    const res = await r.testChat()
    expect(res.ok).toBe(true)
  })
})

describe('AiRuntime reranker slot', () => {
  test('未配置 reranker 时 hasReranker=false 且 rerank 抛错', async () => {
    const r = makeRuntime(emptyConfig())
    expect(r.hasReranker()).toBe(false)
    await expect(r.rerank({ query: 'q', texts: ['x'] })).rejects.toThrow('not configured')
  })

  test('配置后 rerank 透传到 TEI', async () => {
    const fetchImpl = mockFetchJson(200, [{ index: 0, score: 0.7 }])
    const r = makeRuntime(
      {
        version: 1,
        chat: null,
        embedding: null,
        autoIndex: true,
        reranker: {
          enabled: true,
          baseUrl: 'http://tei.local',
          apiKey: '',
          model: 'bge-reranker-v2-m3',
          timeoutMs: 5000,
        },
      },
      fetchImpl,
    )
    expect(r.hasReranker()).toBe(true)
    const out = await r.rerank({ query: 'q', texts: ['x'] })
    expect(out[0]).toEqual({ index: 0, score: 0.7 })
    expect(r.status().reranker.configured).toBe(true)
    expect(r.status().usage.rerankCalls).toBe(1)
  })

  test('rerank 失败时记录 lastError + errors+1', async () => {
    const fetchImpl = mockFetchJson(500, { error: 'boom' })
    const r = makeRuntime(
      {
        version: 1,
        chat: null,
        embedding: null,
        autoIndex: true,
        reranker: {
          enabled: true,
          baseUrl: 'http://tei.local',
          apiKey: '',
          model: 'bge',
          timeoutMs: 5000,
        },
      },
      fetchImpl,
    )
    await expect(r.rerank({ query: 'q', texts: ['x'] })).rejects.toThrow()
    expect(r.status().usage.rerankErrors).toBe(1)
    expect(r.status().reranker.lastError).toBeTruthy()
  })
})

describe('AiRuntime capabilities', () => {
  test('空配置 → 全 false 但 hybrid_search=true', () => {
    const r = makeRuntime(emptyConfig())
    const c = r.capabilities()
    expect(c.ai_enabled).toBe(false)
    expect(c.embedding).toBe(false)
    expect(c.chat).toBe(false)
    expect(c.reranker).toBe(false)
    expect(c.hybrid_search).toBe(true)
  })

  test('只配 embedding 时 chat=false embedding=true', () => {
    const r = makeRuntime(makeEmbConfig())
    const c = r.capabilities()
    expect(c.ai_enabled).toBe(true)
    expect(c.embedding).toBe(true)
    expect(c.chat).toBe(false)
  })

  test('只配 chat 时 ai_enabled=true chat=true embedding=false', () => {
    const r = makeRuntime({
      version: 1,
      chat: makeProviderLike(),
      embedding: null,
      autoIndex: true,
      reranker: null,
    })
    const c = r.capabilities()
    expect(c.ai_enabled).toBe(true)
    expect(c.chat).toBe(true)
    expect(c.embedding).toBe(false)
  })

  test('只配 reranker 时 ai_enabled 由 chat/embedding 决定', () => {
    const r = makeRuntime({
      version: 1,
      chat: null,
      embedding: null,
      autoIndex: true,
      reranker: {
        enabled: true,
        baseUrl: 'http://x',
        apiKey: '',
        model: 'bge',
        timeoutMs: 5000,
      },
    })
    const c = r.capabilities()
    expect(c.ai_enabled).toBe(false)
    expect(c.reranker).toBe(true)
  })
})

describe('AiRuntime streamChat', () => {
  test('未启用时抛错', async () => {
    const r = makeRuntime(emptyConfig())
    await expect(
      (async () => {
        for await (const _ of r.streamChat([{ role: 'user', content: 'hi' }])) {
          // drain
        }
      })(),
    ).rejects.toThrow('not configured')
  })

  test('解析 SSE 数据流并拼接 token', async () => {
    const chunks: string[] = []
    chunks.push('data: {"choices":[{"delta":{"content":"He"}}]}\n\n')
    chunks.push('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n')
    chunks.push('data: [DONE]\n\n')

    const encoder = new TextEncoder()
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c))
            controller.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch

    const r = makeRuntime(makeFullConfig(), fetchImpl)
    const collected: string[] = []
    let seenDone = false
    for await (const c of r.streamChat([{ role: 'user', content: 'hi' }])) {
      if (c.done) seenDone = true
      else if (c.content) collected.push(c.content)
    }
    expect(collected.join('')).toBe('Hello')
    expect(seenDone).toBe(true)
    expect(r.status().usage.chatCalls).toBe(1)
  })

  test('解析 reasoning_content 增量', async () => {
    const chunks: string[] = []
    chunks.push('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n')
    chunks.push('data: {"choices":[{"delta":{"content":"ans"}}]}\n\n')
    chunks.push('data: [DONE]\n\n')

    const encoder = new TextEncoder()
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c))
            controller.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch

    const r = makeRuntime(makeFullConfig(), fetchImpl)
    const reasoning: string[] = []
    const content: string[] = []
    for await (const c of r.streamChat([{ role: 'user', content: 'hi' }])) {
      if (c.reasoning) reasoning.push(c.reasoning)
      if (c.content) content.push(c.content)
    }
    expect(reasoning.join('')).toBe('think')
    expect(content.join('')).toBe('ans')
  })

  test('streamChatWithTools 累计 tool_calls', async () => {
    const chunks: string[] = []
    chunks.push(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"notefast_search_more","arguments":""}}]}}]}\n\n',
    )
    chunks.push(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":\\"x\\"}"}}]}}]}\n\n',
    )
    chunks.push('data: [DONE]\n\n')

    const encoder = new TextEncoder()
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c))
            controller.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch

    const r = makeRuntime(makeFullConfig(), fetchImpl)
    let toolCalls: Array<{ name: string; args: Record<string, unknown> }> = []
    for await (const c of r.streamChatWithTools([{ role: 'user', content: 'hi' }], { tools: [] })) {
      if (c.done && c.tool_calls) toolCalls = c.tool_calls
    }
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]?.name).toBe('notefast_search_more')
    expect(toolCalls[0]?.args).toEqual({ query: 'x' })
  })
})

describe('stripThinkTags（推理模型 content 内联 <think>）', () => {
  test('非流式 chat 剥离 <think> 块与围栏前的思考内容', async () => {
    const thinkWrapped =
      '<think>让我分析一下……结论是 {"mentions": []}</think>\n\n```json\n{"mentions": []}\n```'
    const r = makeRuntime(
      makeFullConfig(),
      mockFetchJson(200, { choices: [{ message: { content: thinkWrapped } }] }),
    )
    const out = await r.chat([{ role: 'user', content: 'x' }], { responseFormat: { type: 'json_object' } })
    expect(out).toBe('```json\n{"mentions": []}\n```')
    expect(out).not.toContain('<think>')
  })

  test('未闭合 <think>（maxTokens 截断）剥到结尾', async () => {
    const r = makeRuntime(
      makeFullConfig(),
      mockFetchJson(200, { choices: [{ message: { content: '<think>被截断的思考…' } }] }),
    )
    const out = await r.chat([{ role: 'user', content: 'x' }])
    expect(out).toBe('')
  })

  test('无 <think> 时内容原样返回', async () => {
    const r = makeRuntime(
      makeFullConfig(),
      mockFetchJson(200, { choices: [{ message: { content: '正常回答' } }] }),
    )
    const out = await r.chat([{ role: 'user', content: 'x' }])
    expect(out).toBe('正常回答')
  })
})

describe('parseLlmJson（LLM JSON 容错解析共享路径）', () => {
  test('think 包裹 + 代码围栏 + 纯 JSON 均解析成功', () => {
    expect(parseLlmJson('<think>……</think>\n```json\n{"a": 1}\n```')).toEqual({ a: 1 })
    expect(parseLlmJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 })
    expect(parseLlmJson('{"a": 1}')).toEqual({ a: 1 })
  })

  test('围栏外夹杂文字时提取首尾 {...} 段', () => {
    expect(parseLlmJson('好的，结果是：\n{"a": 1}\n请确认。')).toEqual({ a: 1 })
  })

  test('完全无法解析返回 null', () => {
    expect(parseLlmJson('这不是 JSON')).toBeNull()
    expect(parseLlmJson('')).toBeNull()
  })
})

describe('signal 贯穿（客户端断连取消上游请求）', () => {
  test('chat options.signal 传到 fetch；abort 中止进行中的请求（AbortError 不污染失败计数）', async () => {
    let receivedSignal: AbortSignal | null = null
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal ?? null
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    }) as unknown as typeof fetch
    const r = makeRuntime(makeFullConfig(), fetchImpl)
    const ac = new AbortController()
    const p = r.chat([{ role: 'user', content: 'x' }], { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toThrow()
    expect(receivedSignal).not.toBeNull()
  })

  test('不传 signal 且未配超时：不附带 AbortSignal（保持既有请求形态）', async () => {
    let receivedSignal: AbortSignal | null | undefined = null
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const r = makeRuntime(makeFullConfig({ timeoutMs: undefined }), fetchImpl)
    const out = await r.chat([{ role: 'user', content: 'x' }])
    expect(out).toBe('ok')
    expect(receivedSignal).toBeUndefined()
  })
})
