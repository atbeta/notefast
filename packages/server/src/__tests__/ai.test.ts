import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { initDb, closeDb } from '../db'
import { createPluginSystem, type AiConfig } from '@notefast/core'
import {
  initAiRuntime,
  applyNewConfig,
  _setRuntimeForTests,
  loadConfigFromDisk,
  getRuntime,
} from '../services/aiRuntime'
import ai from '../api/ai'

let testDir: string
let app: Hono
let pluginSystem: ReturnType<typeof createPluginSystem>
const originalFetch = globalThis.fetch

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-ai-test-'))
  initDb(testDir)
  pluginSystem = createPluginSystem()
  app = new Hono()
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }))
  app.route('/api/v1/ai', ai)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  // 每次测试重置 runtime 和磁盘上的 config，避免上一个 test 残留
  _setRuntimeForTests(null)
  const configPath = join(testDir, 'ai.config.json')
  if (existsSync(configPath)) unlinkSync(configPath)
})

async function api(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await app.fetch(new Request(`http://localhost${path}`, init))
  return { status: res.status, body: await res.json() }
}

describe('GET /api/v1/ai/status', () => {
  test('runtime 未初始化时返回 enabled=false + fix_hint', async () => {
    const { status, body } = await api('GET', '/api/v1/ai/status')
    expect(status).toBe(200)
    expect(body.enabled).toBe(false)
    expect(body.fix_hint).toContain('/settings')
  })

  test('配置后 status 暴露 embedding/chat 状态和 usage', async () => {
    initAiRuntime(pluginSystem, testDir)
    const { status, body } = await api('GET', '/api/v1/ai/status')
    expect(status).toBe(200)
    expect(body.enabled).toBe(false) // 空 env，无 active provider
    expect(body.usage.embeddingCalls).toBe(0)
  })
})

describe('PUT /api/v1/ai/config', () => {
  beforeEach(() => {
    initAiRuntime(pluginSystem, testDir)
  })

  test('有效配置可保存到磁盘 + 热重载', async () => {
    const cfg = {
      active: {
        id: 'test-1',
        label: 'Test',
        preset: 'custom',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        embeddingModel: 'text-embedding-3-small',
        chatModel: 'gpt-4o-mini',
        timeoutMs: 30_000,
        extraHeaders: {},
      },
      autoIndex: true,
    }
    const { status, body } = await api('PUT', '/api/v1/ai/config', cfg)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.status.enabled).toBe(true)

    const path = join(testDir, 'ai.config.json')
    expect(existsSync(path)).toBe(true)
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'))
    expect(onDisk.active.apiKey).toBe('sk-test')
  })

  test('保存的配置 reload 后从磁盘恢复', () => {
    const cfg: AiConfig = {
      version: 1,
      active: {
        id: 'persist-1',
        label: 'Persist',
        preset: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-persist',
        embeddingModel: 'text-embedding-3-small',
        chatModel: 'gpt-4o-mini',
        timeoutMs: 60_000,
        extraHeaders: {},
      },
      autoIndex: false,
    }
    applyNewConfig(cfg, pluginSystem)

    // 模拟重启：清空 runtime，从磁盘重新加载
    _setRuntimeForTests(null)
    const restored = loadConfigFromDisk()
    expect(restored.active).not.toBeNull()
    expect(restored.active!.apiKey).toBe('sk-persist')
    expect(restored.autoIndex).toBe(false)
  })

  test('非法 baseUrl 返回 ok=false + errors', async () => {
    const cfg = {
      active: {
        id: 'bad',
        label: 'Bad',
        preset: 'custom',
        baseUrl: '',
        apiKey: '',
        embeddingModel: 'emb',
        chatModel: '',
        timeoutMs: 30_000,
        extraHeaders: {},
      },
      autoIndex: true,
    }
    const { status } = await api('PUT', '/api/v1/ai/config', cfg)
    // Zod 校验拦截空 baseUrl → 400；这是预期行为
    expect(status).toBe(400)
  })

  test('active=null 表示禁用 AI', async () => {
    const { status, body } = await api('PUT', '/api/v1/ai/config', {
      active: null,
      autoIndex: true,
    })
    expect(status).toBe(200)
    expect(body.status.enabled).toBe(false)
  })
})

describe('GET /api/v1/ai/config', () => {
  test('apiKey 被脱敏', async () => {
    initAiRuntime(pluginSystem, testDir)
    applyNewConfig(
      {
        version: 1,
        active: {
          id: 'a',
          label: 'a',
          preset: 'custom',
          baseUrl: 'https://x.com/v1',
          apiKey: 'sk-verylongsecret1234',
          embeddingModel: 'e',
          chatModel: 'c',
          timeoutMs: 30_000,
          extraHeaders: {},
        },
        autoIndex: true,
      },
      pluginSystem,
    )
    const { status, body } = await api('GET', '/api/v1/ai/config')
    expect(status).toBe(200)
    expect(body.active.apiKey).toBe('***set***')
  })
})

describe('POST /api/v1/ai/test', () => {
  beforeEach(() => {
    initAiRuntime(pluginSystem, testDir)
    applyNewConfig(
      {
        version: 1,
        active: {
          id: 't',
          label: 't',
          preset: 'custom',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          embeddingModel: 'text-embedding-3-small',
          chatModel: 'gpt-4o-mini',
          timeoutMs: 30_000,
          extraHeaders: {},
        },
        autoIndex: false,
      },
      pluginSystem,
    )
  })

  test('chat/embedding 都正常时返回 ok=true + dim', async () => {
    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/embeddings')) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    getRuntime().setFetchImpl(mockFetch)

    const { status, body } = await api('POST', '/api/v1/ai/test')
    expect(status).toBe(200)
    expect(body.chat.ok).toBe(true)
    expect(body.embedding.ok).toBe(true)
    expect(body.embedding.dim).toBe(3)
  })

  test('embedding 返回 4xx 时记录 lastError', async () => {
    const failFetch = (async () =>
      new Response('unauthorized', { status: 401 })) as unknown as typeof fetch
    getRuntime().setFetchImpl(failFetch)
    const { body } = await api('POST', '/api/v1/ai/test')
    expect(body.embedding.ok).toBe(false)
    expect(body.embedding.lastError).toContain('401')
  })
})

describe('POST /api/v1/ai/suggest-title', () => {
  beforeEach(() => {
    initAiRuntime(pluginSystem, testDir)
  })

  test('chat 未配置时返回 400 + fix_hint', async () => {
    const { status, body } = await api('POST', '/api/v1/ai/suggest-title', {
      content: '一段笔记',
    })
    expect(status).toBe(400)
    expect(body.error).toBe('not_configured')
    expect(body.fix_hint).toContain('/settings')
  })

  test('chat 正常时返回 title + summary', async () => {
    applyNewConfig(
      {
        version: 1,
        active: {
          id: 's',
          label: 's',
          preset: 'custom',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          embeddingModel: '',
          chatModel: 'gpt-4o-mini',
          timeoutMs: 30_000,
          extraHeaders: {},
        },
        autoIndex: false,
      },
      pluginSystem,
    )
    const mockChat = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"React 笔记","summary":"关于 hooks"}' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch
    getRuntime().setFetchImpl(mockChat)
    const { status, body } = await api('POST', '/api/v1/ai/suggest-title', {
      content: '这是一段关于 React Hooks 的内容',
    })
    expect(status).toBe(200)
    expect(body.title).toBe('React 笔记')
    expect(body.summary).toBe('关于 hooks')
  })
})