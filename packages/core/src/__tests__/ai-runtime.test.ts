import { describe, test, expect } from 'bun:test'
import {
  AiRuntime,
  resetAiRuntimeForTests,
  type AiRuntimeOptions,
} from '../ai/runtime'
import { makeProviderLike } from './helpers'
import { emptyConfig } from '../ai/config'
import type { AiConfig } from '../ai/config'

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

describe('AiRuntime 基础状态', () => {
  test('空配置 → disabled', () => {
    resetAiRuntimeForTests()
    const r = makeRuntime(emptyConfig())
    const s = r.status()
    expect(s.enabled).toBe(false)
    expect(s.embedding.configured).toBe(false)
    expect(s.chat.configured).toBe(false)
  })

  test('只配 embedding', () => {
    const r = makeRuntime({
      version: 1,
      autoIndex: true,
      active: makeProviderLike({ chatModel: '' }),
    })
    const s = r.status()
    expect(s.enabled).toBe(true)
    expect(s.embedding.configured).toBe(true)
    expect(s.chat.configured).toBe(false)
    expect(r.hasEmbedding()).toBe(true)
    expect(r.hasChat()).toBe(false)
  })

  test('status 暴露脱敏后的 apiKey', () => {
    const r = makeRuntime({
      version: 1,
      autoIndex: true,
      active: makeProviderLike({ apiKey: 'sk-verylongsecret1234' }),
    })
    const s = r.status()
    expect(s.config.active).not.toBeNull()
    expect(s.config.active!.apiKey).toBe('***set***')
  })
})

describe('AiRuntime reload', () => {
  test('从 enabled 切换到 disabled 立即生效', () => {
    const r = makeRuntime({
      version: 1,
      autoIndex: true,
      active: makeProviderLike(),
    })
    expect(r.hasEmbedding()).toBe(true)
    r.reload({ version: 1, autoIndex: true, active: null })
    expect(r.hasEmbedding()).toBe(false)
    expect(r.status().enabled).toBe(false)
  })

  test('reload 清空旧的 lastError', () => {
    const failFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const r = makeRuntime(
      { version: 1, autoIndex: true, active: makeProviderLike() },
      failFetch,
    )
    // 触发一次失败
    r.embedQuery('x').catch(() => {})
    // reload 后错误应清空
    r.reload({ version: 1, autoIndex: true, active: makeProviderLike() })
    expect(r.status().embedding.lastError).toBeUndefined()
  })
})

describe('AiRuntime embedQuery', () => {
  test('未启用时返回 null', async () => {
    const r = makeRuntime(emptyConfig())
    expect(await r.embedQuery('x')).toBeNull()
  })

  test('成功时 usage 计数 +1，dim 被记录', async () => {
    const fakeVec = Array.from({ length: 4 }, (_, i) => i + 1)
    const fetchImpl = mockFetchJson(200, { data: [{ embedding: fakeVec }] })
    const r = makeRuntime(
      { version: 1, autoIndex: true, active: makeProviderLike() },
      fetchImpl,
    )
    const v = await r.embedQuery('hi')
    expect(v).not.toBeNull()
    expect(v!.length).toBe(4)
    expect(r.status().usage.embeddingCalls).toBe(1)
    expect(r.status().embedding.dim).toBe(4)
    expect(r.status().embedding.lastError).toBeUndefined()
  })

  test('失败时 embeddingErrors +1 且 lastError 被记录', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 401 })) as unknown as typeof fetch
    const r = makeRuntime(
      { version: 1, autoIndex: true, active: makeProviderLike() },
      fetchImpl,
    )
    await expect(r.embedQuery('x')).rejects.toThrow()
    expect(r.status().usage.embeddingErrors).toBe(1)
    expect(r.status().embedding.lastError).toContain('401')
  })
})

describe('AiRuntime chat', () => {
  test('未启用 chat 时抛错', async () => {
    const r = makeRuntime({
      version: 1,
      autoIndex: true,
      active: makeProviderLike({ chatModel: '' }),
    })
    await expect(r.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('not configured')
  })

  test('成功时解析 content 并累计 usage', async () => {
    const fetchImpl = mockFetchJson(200, {
      choices: [{ message: { content: 'pong' } }],
    })
    const r = makeRuntime(
      { version: 1, autoIndex: true, active: makeProviderLike() },
      fetchImpl,
    )
    const reply = await r.chat([{ role: 'user', content: 'ping' }])
    expect(reply).toBe('pong')
    expect(r.status().usage.chatCalls).toBe(1)
  })

  test('失败时记录 chatLastError', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    const r = makeRuntime(
      { version: 1, autoIndex: true, active: makeProviderLike() },
      fetchImpl,
    )
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
    const r = makeRuntime(
      { version: 1, autoIndex: true, active: makeProviderLike() },
      fetchImpl,
    )
    const res = await r.testChat()
    expect(res.ok).toBe(true)
  })
})