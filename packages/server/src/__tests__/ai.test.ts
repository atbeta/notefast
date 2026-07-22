import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { initDb, closeDb, getDb } from '../db'
import { createPluginSystem, type AiConfig, type ProviderDefinition } from '@notefast/core'
import {
  initAiRuntime,
  applyNewConfig,
  _setRuntimeForTests,
  loadConfigFromDisk,
} from '../services/aiRuntime'
import ai from '../api/ai'
import { embeddingFingerprint } from '../ai/vectorStore'
import { initVectorStore } from '../ai/indexer'

let testDir: string
let app: Hono
let pluginSystem: ReturnType<typeof createPluginSystem>
const originalFetch = globalThis.fetch

const FULL_PROVIDER: ProviderDefinition = {
  id: 'test-1',
  label: 'Test',
  preset: 'custom',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  embeddingModel: 'text-embedding-3-small',
  chatModel: 'gpt-4o-mini',
  timeoutMs: 30_000,
  extraHeaders: {},
}

beforeAll(async () => {
  testDir = mkdtempSync(join('/tmp', 'notefast-ai-test-'))
  initDb(testDir)
  await initVectorStore()
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
  const text = await res.text()
  let parsed: any = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { _raw: text }
  }
  return { status: res.status, body: parsed }
}

describe('GET /api/v1/ai/status', () => {
  test('runtime 未初始化时返回 enabled=false + fix_hint', async () => {
    const { status, body } = await api('GET', '/api/v1/ai/status')
    expect(status).toBe(200)
    expect(body.enabled).toBe(false)
    expect(body.vectorStore.backend).toBeDefined()
    expect(body.fix_hint).toContain('/settings')
  })

  test('配置后 status 暴露 embedding/chat 状态和 usage', async () => {
    initAiRuntime(pluginSystem, testDir)
    applyNewConfig(
      {
        version: 1,
        chat: FULL_PROVIDER,
        embedding: FULL_PROVIDER,
        autoIndex: true,
        reranker: null,
      },
      pluginSystem,
    )
    const { status, body } = await api('GET', '/api/v1/ai/status')
    expect(status).toBe(200)
    expect(body.enabled).toBe(true)
    expect(body.usage.embeddingCalls).toBe(0)
  })
})

describe('向量索引状态与重建 API', () => {
  test('GET /index/status 暴露后端与索引状态', async () => {
    const { status, body } = await api('GET', '/api/v1/ai/index/status')
    expect(status).toBe(200)
    expect(body.backend).toBeDefined()
    expect(body.status).toBeDefined()
    expect(typeof body.count).toBe('number')
  })

  test('POST /index/rebuild 未配置 embedding 时拒绝启动', async () => {
    const { status, body } = await api('POST', '/api/v1/ai/index/rebuild')
    expect(status).toBe(400)
    expect(body.error).toBe('not_configured')
  })

  test('更换 embedding 模型时自动标记现有索引 stale', async () => {
    initAiRuntime(pluginSystem, testDir)
    getDb().query(
      `UPDATE vector_store_state
       SET status = 'ready', model_fingerprint = ?, dimension = 3
       WHERE id = 'default'`,
    ).run(embeddingFingerprint(FULL_PROVIDER))
    applyNewConfig(
      {
        version: 1,
        chat: null,
        embedding: { ...FULL_PROVIDER, embeddingModel: 'different-model' },
        autoIndex: false,
        reranker: null,
      },
      pluginSystem,
    )

    const { body } = await api('GET', '/api/v1/ai/index/status')
    expect(body.status).toBe('stale')
    expect(body.error).toContain('模型')
  })
})

describe('PUT /api/v1/ai/config', () => {
  beforeEach(() => {
    initAiRuntime(pluginSystem, testDir)
  })

  test('有效配置可保存到磁盘 + 热重载', async () => {
    const cfg = { chat: FULL_PROVIDER, embedding: null, autoIndex: true }
    const { status, body } = await api('PUT', '/api/v1/ai/config', cfg)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.status.enabled).toBe(true)

    const path = join(testDir, 'ai.config.json')
    expect(existsSync(path)).toBe(true)
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'))
    expect(onDisk.chat.apiKey).toBe('sk-test')
  })

  test('独立 chat + embedding 同时保存', async () => {
    const cfg = {
      chat: FULL_PROVIDER,
      embedding: { ...FULL_PROVIDER, id: 'emb-1', baseUrl: 'https://emb.example.com/v1', apiKey: 'sk-emb', embeddingModel: 'bge-m3', chatModel: '' },
      autoIndex: true,
    }
    const { status, body } = await api('PUT', '/api/v1/ai/config', cfg)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)

    const onDisk = JSON.parse(readFileSync(join(testDir, 'ai.config.json'), 'utf-8'))
    expect(onDisk.chat.apiKey).toBe('sk-test')
    expect(onDisk.embedding.apiKey).toBe('sk-emb')
    expect(onDisk.embedding.baseUrl).toBe('https://emb.example.com/v1')
  })

  test('回传脱敏占位符 ***set*** 时保留磁盘上的真实 Key（chat 与 embedding 各自独立）', async () => {
    const cfg = {
      chat: { ...FULL_PROVIDER, apiKey: 'sk-real-secret-key', embeddingModel: '', chatModel: 'some-model' },
      embedding: { ...FULL_PROVIDER, id: 'emb-real', apiKey: 'sk-real-emb', baseUrl: 'https://emb.example.com/v1', embeddingModel: 'bge-m3', chatModel: '' },
      autoIndex: true,
    }
    await api('PUT', '/api/v1/ai/config', cfg)

    // 第二次保存：UI 只改了 chat 模型，原样回传
    const cfg2 = {
      chat: { ...cfg.chat, apiKey: '***set***', chatModel: 'other-model' },
      embedding: { ...cfg.embedding, apiKey: '***set***' },
      autoIndex: true,
    }
    const { status } = await api('PUT', '/api/v1/ai/config', cfg2)
    expect(status).toBe(200)

    const onDisk = JSON.parse(readFileSync(join(testDir, 'ai.config.json'), 'utf-8'))
    expect(onDisk.chat.apiKey).toBe('sk-real-secret-key')
    expect(onDisk.chat.chatModel).toBe('other-model')
    expect(onDisk.embedding.apiKey).toBe('sk-real-emb')
  })

  test('回传真实新 Key 时使用新值；显式空串表示清除', async () => {
    const base = { ...FULL_PROVIDER, id: 'key-2', embeddingModel: '', chatModel: 'm' }
    await api('PUT', '/api/v1/ai/config', { chat: base, embedding: null, autoIndex: true })

    await api('PUT', '/api/v1/ai/config', { chat: { ...base, apiKey: 'sk-second' }, embedding: null, autoIndex: true })
    let onDisk = JSON.parse(readFileSync(join(testDir, 'ai.config.json'), 'utf-8'))
    expect(onDisk.chat.apiKey).toBe('sk-second')

    await api('PUT', '/api/v1/ai/config', { chat: { ...base, apiKey: '' }, embedding: null, autoIndex: true })
    onDisk = JSON.parse(readFileSync(join(testDir, 'ai.config.json'), 'utf-8'))
    expect(onDisk.chat.apiKey).toBe('')
  })

  test('保存的配置 reload 后从磁盘恢复', () => {
    const cfg: AiConfig = {
      version: 1,
      chat: { ...FULL_PROVIDER, id: 'persist-1', label: 'Persist', preset: 'openai', apiKey: 'sk-persist' },
      embedding: null,
      autoIndex: false,
      reranker: null,
    }
    applyNewConfig(cfg, pluginSystem)

    // 模拟重启：清空 runtime，从磁盘重新加载
    _setRuntimeForTests(null)
    const restored = loadConfigFromDisk()
    expect(restored.chat).not.toBeNull()
    expect(restored.chat!.apiKey).toBe('sk-persist')
    expect(restored.autoIndex).toBe(false)
  })

  test('旧 shape（带 active 字段）从磁盘加载时被丢弃', () => {
    // 写一个旧 shape 文件
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(
      join(testDir, 'ai.config.json'),
      JSON.stringify(
        {
          version: 1,
          active: { ...FULL_PROVIDER, apiKey: 'old-key' },
          autoIndex: true,
          reranker: null,
        },
        null,
        2,
      ),
    )
    const restored = loadConfigFromDisk()
    // 应当丢弃文件 → 返回空配置
    expect(restored.chat).toBeNull()
    expect(restored.embedding).toBeNull()
    expect(existsSync(join(testDir, 'ai.config.json'))).toBe(false)
  })

  test('非 legacy preset（如 siliconflow / cohere / voyage）也能保存', async () => {
    const cases = [
      { id: 'sf-1', preset: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', chatModel: 'deepseek-ai/DeepSeek-V4-Flash' },
      { id: 'vh-1', preset: 'voyage', baseUrl: 'https://api.voyageai.com/v1', chatModel: '', embeddingModel: 'voyage-4-large' },
    ]
    for (const c of cases) {
      _setRuntimeForTests(null)
      initAiRuntime(pluginSystem, testDir)
      const cfg = {
        chat: c.chatModel ? { ...FULL_PROVIDER, id: c.id, preset: c.preset as never, baseUrl: c.baseUrl, chatModel: c.chatModel, embeddingModel: '' } : null,
        embedding: c.embeddingModel
          ? { ...FULL_PROVIDER, id: c.id + '-emb', preset: c.preset as never, baseUrl: c.baseUrl, embeddingModel: c.embeddingModel, chatModel: '' }
          : null,
        autoIndex: true,
      }
      const { status, body } = await api('PUT', '/api/v1/ai/config', cfg)
      expect(status, `${c.preset} 应当能保存`).toBe(200)
      expect(body.ok).toBe(true)
      const onDisk = JSON.parse(readFileSync(join(testDir, 'ai.config.json'), 'utf-8'))
      const target = c.chatModel ? onDisk.chat : onDisk.embedding
      expect(target.preset).toBe(c.preset)
      expect(target.baseUrl).toBe(c.baseUrl)
    }
  })

  test('非法 chat baseUrl 返回 400', async () => {
    const cfg = {
      chat: { ...FULL_PROVIDER, id: 'bad', label: 'Bad', baseUrl: '' },
      embedding: null,
      autoIndex: true,
    }
    const { status } = await api('PUT', '/api/v1/ai/config', cfg)
    expect(status).toBe(400)
  })

  test('非法 embedding（缺 embeddingModel）返回 400', async () => {
    const cfg = {
      chat: FULL_PROVIDER,
      embedding: { ...FULL_PROVIDER, id: 'bad-emb', embeddingModel: '' },
      autoIndex: true,
    }
    const { status } = await api('PUT', '/api/v1/ai/config', cfg)
    expect(status).toBe(400)
  })

  test('chat=null 且 embedding=null 表示禁用 AI', async () => {
    const { status, body } = await api('PUT', '/api/v1/ai/config', {
      chat: null,
      embedding: null,
      autoIndex: true,
    })
    expect(status).toBe(200)
    expect(body.status.enabled).toBe(false)
  })
})

describe('GET /api/v1/ai/config', () => {
  test('apiKey 被脱敏（chat 与 embedding 各自）', async () => {
    initAiRuntime(pluginSystem, testDir)
    applyNewConfig(
      {
        version: 1,
        chat: { ...FULL_PROVIDER, id: 'a', label: 'a', apiKey: 'sk-verylongsecret1234' },
        embedding: { ...FULL_PROVIDER, id: 'b', label: 'b', baseUrl: 'https://emb.example.com/v1', apiKey: 'sk-anothersecret6789', embeddingModel: 'bge-m3', chatModel: '' },
        autoIndex: true,
        reranker: null,
      },
      pluginSystem,
    )
    const { status, body } = await api('GET', '/api/v1/ai/config')
    expect(status).toBe(200)
    expect(body.chat.apiKey).toBe('***set***')
    expect(body.embedding.apiKey).toBe('***set***')
  })
})
