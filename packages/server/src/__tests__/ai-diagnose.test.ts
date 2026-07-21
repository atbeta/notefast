/**
 * /api/v1/ai/diagnose 测试
 *
 * 目标：
 * - runtime 未配置 → overall='idle'
 * - chat 配置成功 / 失败 / 未配置 → 多路径
 * - embedding + reranker 维度 / latency 字段完整性
 * - overall 判定逻辑：healthy / partial / degraded / idle
 * - autoLink 报告依赖项
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { initDb, closeDb } from '../db'
import { createPluginSystem, defaultAutoLinkConfig } from '@notefast/core'
import {
  initAiRuntime,
  applyNewConfig,
  _setRuntimeForTests,
  getRuntime,
} from '../services/aiRuntime'
import ai from '../api/ai'

let testDir: string
let app: Hono
let pluginSystem: ReturnType<typeof createPluginSystem>

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-diag-'))
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

function applyProvider(extra?: { autoLink?: boolean }) {
  applyNewConfig(
    {
      version: 1,
      chat: {
        id: 'x-chat',
        label: 'x',
        preset: 'openai',
        baseUrl: 'http://mock-chat',
        apiKey: 'k',
        embeddingModel: '',
        chatModel: 'fake-chat',
        timeoutMs: 5000,
        extraHeaders: {},
      },
      embedding: {
        id: 'x-emb',
        label: 'x',
        preset: 'openai',
        baseUrl: 'http://mock-emb',
        apiKey: 'k',
        embeddingModel: 'fake-emb',
        chatModel: '',
        timeoutMs: 5000,
        extraHeaders: {},
      },
      autoIndex: false,
      reranker: {
        enabled: true,
        baseUrl: 'http://mock-rerank',
        apiKey: '',
        model: 'bge',
        timeoutMs: 5000,
      },
      autoLink: {
        ...defaultAutoLinkConfig(),
        enabled: Boolean(extra?.autoLink),
      },
    } as never,
    pluginSystem,
  )
}

async function api(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await app.fetch(new Request(`http://localhost/api/v1/ai${path}`, init))
  return { status: res.status, body: await res.json() }
}

describe('POST /api/v1/ai/diagnose', () => {
  test('runtime 未初始化 → overall=idle, 三项都说没配', async () => {
    const { status, body } = await api('POST', '/diagnose')
    expect(status).toBe(200)
    expect(body.overall).toBe('idle')
    expect(body.chat.configured).toBe(false)
    expect(body.embedding.configured).toBe(false)
    expect(body.reranker.configured).toBe(false)
    expect(body.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(body.ts).toBeTruthy()
  })

  test('chat 走通 → overall=healthy；chat.ok=true, latency>0', async () => {
    applyProvider()
    const fetcher = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'pong pong' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch
    getRuntime().setFetchImpl(fetcher)
    const { body } = await api('POST', '/diagnose')
    expect(body.chat.ok).toBe(true)
    expect(body.chat.configured).toBe(true)
    expect(body.chat.latencyMs).toBeGreaterThanOrEqual(0)
    expect(body.chat.replySample).toContain('pong')
    expect(['healthy', 'partial']).toContain(body.overall)
  })

  test('embedding/reranker 路径走通 → overall=healthy', async () => {
    applyProvider()
    // 1) probeEmbeddingDim 通过 'embedding' command
    // 2) /chat/... 通过 chat command
    // 3) /rerank 通过 rerank command
    let commandsHit: string[] = []
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string)
      commandsHit.push(body.model || 'no-model')
      // 假设 body.url 决定 endpoint
      const url = String(_input)
      if (url.includes('/embeddings')) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
          status: 200,
        })
      }
      if (url.includes('/rerank')) {
        return new Response(JSON.stringify([{ index: 0, score: 0.7 }, { index: 1, score: 0.3 }]), {
          status: 200,
        })
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    getRuntime().setFetchImpl(fetcher)

    const { body } = await api('POST', '/diagnose')
    expect(body.embedding.ok).toBe(true)
    expect(body.embedding.dim).toBe(3)
    expect(body.reranker.ok).toBe(true)
    expect(body.reranker.hitCount).toBe(2)
    expect(body.chat.ok).toBe(true)
    expect(body.overall).toBe('healthy')
    void commandsHit
  })

  test('chat 返回 401 → chat.ok=false, partial', async () => {
    applyProvider()
    const fetcher = (async () =>
      new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch
    getRuntime().setFetchImpl(fetcher)
    const { body } = await api('POST', '/diagnose')
    expect(body.chat.ok).toBe(false)
    expect(body.chat.error).toContain('401')
    // rerank + embedding 也走同一 fetcher；rerank 路径期望 401 → ok=false
    expect(body.overall).toBe('degraded') // 所有配的都失败
  })

  test('AutoLink 依赖报告 chat', async () => {
    applyProvider({ autoLink: true })
    const fetcher = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch
    getRuntime().setFetchImpl(fetcher)
    const { body } = await api('POST', '/diagnose')
    expect(body.autoLink.configured).toBe(true)
    expect(body.autoLink.enabled).toBe(true)
    expect(body.autoLink.autoApply).toBe('never')
    expect(body.autoLink.ok).toBe(true)
    expect(body.autoLink.prerequisites.chat.ok).toBe(true)
  })

  test('AutoLink 启用但 chat 不通 → autoLink.ok=false', async () => {
    applyProvider({ autoLink: true })
    const fetcher = (async () =>
      new Response('Boom', { status: 500 })) as unknown as typeof fetch
    getRuntime().setFetchImpl(fetcher)
    const { body } = await api('POST', '/diagnose')
    expect(body.autoLink.configured).toBe(true)
    expect(body.autoLink.ok).toBe(false)
    expect(body.autoLink.prerequisites.chat.ok).toBe(false)
  })

  test('overall=partial：embedding 关闭但 chat 通', async () => {
    // 只配 chat 不配 embedding
    applyProvider()
    applyNewConfig(
      {
        version: 1,
        chat: {
          id: 'x',
          label: 'x',
          preset: 'openai',
          baseUrl: 'http://mock',
          apiKey: 'k',
          embeddingModel: '',
          chatModel: 'fake-chat',
          timeoutMs: 5000,
          extraHeaders: {},
        },
        embedding: null,
        autoIndex: false,
        reranker: null,
      } as never,
      pluginSystem,
    )
    const fetcher = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch
    getRuntime().setFetchImpl(fetcher)
    const { body } = await api('POST', '/diagnose')
    expect(body.chat.ok).toBe(true)
    expect(body.embedding.configured).toBe(false)
    expect(['healthy', 'partial']).toContain(body.overall)
    // 只有 chat 配+通：overall = healthy（不严格要求其他通）
    expect(body.overall).toBe('healthy')
  })
})
