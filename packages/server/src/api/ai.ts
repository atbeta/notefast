/**
 * AI API
 *
 * 路由：
 * - GET    /api/v1/ai/status     完整状态（含 lastError / dim / usage）
 * - GET    /api/v1/ai/config     当前配置（apiKey 脱敏）
 * - PUT    /api/v1/ai/config     更新配置 + 热重载
 * - POST   /api/v1/ai/test       连通性测试（chat + embedding）
 * - GET    /api/v1/ai/search     语义搜索
 * - POST   /api/v1/ai/index      全量重建索引
 * - POST   /api/v1/ai/index/:id  索引单 block
 * - POST   /api/v1/ai/suggest-title  标题/摘要生成
 *
 * fix_hint 约定：所有 not_configured 错误都附带 hint，引导调用方去 /settings
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import {
  type AiConfig,
  type LLMProvider,
  emptyConfig,
  suggestTitle,
} from '@notefast/core'
import {
  getRuntime,
  applyNewConfigFromCurrent,
  hasRuntime,
} from '../services/aiRuntime'
import { indexBlock, indexAllBlocks, semanticSearch } from '../ai/indexer'

const ai = new Hono()

const FIX_HINT = '请在 Web UI /settings 页面配置 AI Provider（API Key + Base URL + 模型名）'

// ───────────────────── status ─────────────────────

ai.get('/status', (c) => {
  if (!runtimeSafe()) {
    return c.json({ enabled: false, embedding: { configured: false, ok: false }, chat: { configured: false, ok: false }, usage: emptyUsage(), config: emptyConfig(), fix_hint: FIX_HINT })
  }
  const r = getRuntime()
  const s = r.status()
  return c.json({ ...s, fix_hint: s.enabled ? undefined : FIX_HINT })
})

// ───────────────────── config ─────────────────────

ai.get('/config', (c) => {
  if (!runtimeSafe()) return c.json(emptyConfig())
  return c.json(getRuntime().status().config)
})

const configSchema = z.object({
  active: z
    .object({
      id: z.string(),
      label: z.string().min(1),
      preset: z.enum(['openai', 'deepseek', 'openrouter', 'ollama', 'custom']),
      baseUrl: z.string().min(1),
      apiKey: z.string(),
      embeddingModel: z.string(),
      chatModel: z.string(),
      timeoutMs: z.number().int().min(1000).max(600_000),
      extraHeaders: z.record(z.string(), z.string()),
    })
    .nullable(),
  autoIndex: z.boolean(),
})

ai.put(
  '/config',
  zValidator('json', configSchema),
  async (c) => {
    if (!hasRuntime()) {
      return c.json({ error: 'internal', message: 'AI runtime 未初始化' }, 500)
    }
    const body = c.req.valid('json')
    const cfg: AiConfig = { version: 1, active: body.active, autoIndex: body.autoIndex }
    try {
      const result = applyNewConfigFromCurrent(cfg)
      return c.json(result)
    } catch (e) {
      return c.json({ error: 'apply_failed', message: eMsg(e) }, 500)
    }
  },
)

// ───────────────────── test ─────────────────────

ai.post('/test', async (c) => {
  if (!runtimeSafe()) {
    return c.json({ ok: false, message: 'AI 未初始化' }, 400)
  }
  const r = getRuntime()
  const [chatResult, dim] = await Promise.all([
    r.hasChat() ? r.testChat() : Promise.resolve({ ok: false, message: 'Chat 未配置' }),
    r.hasEmbedding() ? r.probeEmbeddingDim() : Promise.resolve(null),
  ])
  return c.json({
    embedding: r.hasEmbedding()
      ? { ok: dim !== null, dim, lastError: r.status().embedding.lastError }
      : { ok: false, message: 'Embedding 未配置' },
    chat: chatResult,
  })
})

// ───────────────────── search / index ─────────────────────

ai.get('/search', async (c) => {
  if (!runtimeSafe()) {
    return c.json({ error: 'not_configured', message: 'AI 未启用', fix_hint: FIX_HINT }, 400)
  }
  const r = getRuntime()
  if (!r.hasEmbedding()) {
    return c.json({ error: 'not_configured', message: 'Embedding 未配置', fix_hint: FIX_HINT }, 400)
  }
  const q = (c.req.query('q') || '').trim()
  if (!q) return c.json([])
  const limit = Math.min(parseInt(c.req.query('limit') || '10', 10) || 10, 20)
  const notebookId = c.req.query('notebook_id') || undefined
  try {
    const v = await r.embedQuery(q)
    if (!v) return c.json({ error: 'embedding_failed', message: 'Embedding 返回为空' }, 500)
    const hits = semanticSearch(v, limit, notebookId)
    return c.json(hits)
  } catch (e) {
    return c.json({ error: 'embedding_error', message: eMsg(e), fix_hint: FIX_HINT }, 500)
  }
})

ai.post('/index', async (c) => {
  if (!runtimeSafe()) {
    return c.json({ error: 'not_configured', message: 'AI 未启用', fix_hint: FIX_HINT }, 400)
  }
  if (!getRuntime().hasEmbedding()) {
    return c.json({ error: 'not_configured', message: 'Embedding 未配置', fix_hint: FIX_HINT }, 400)
  }
  const body = await c.req.json().catch(() => ({} as { notebook_id?: string }))
  try {
    const result = await indexAllBlocks(body.notebook_id)
    return c.json(result)
  } catch (e) {
    return c.json({ error: 'index_error', message: eMsg(e) }, 500)
  }
})

ai.post('/index/:blockId', async (c) => {
  const blockId = c.req.param('blockId')
  if (!runtimeSafe() || !getRuntime().hasEmbedding()) {
    return c.json({ error: 'not_configured', fix_hint: FIX_HINT }, 400)
  }
  try {
    await indexBlock(blockId)
    return c.json({ indexed: true })
  } catch (e) {
    return c.json({ error: 'index_error', message: eMsg(e) }, 500)
  }
})

// ───────────────────── suggest title ─────────────────────

const suggestSchema = z.object({
  content: z.string().min(1).max(5000),
})

ai.post('/suggest-title', zValidator('json', suggestSchema), async (c) => {
  if (!runtimeSafe() || !getRuntime().hasChat()) {
    return c.json(
      {
        error: 'not_configured',
        message: 'AI chat 未配置',
        fix_hint: FIX_HINT,
      },
      400,
    )
  }
  const { content } = c.req.valid('json')
  try {
    const r = getRuntime()
    const provider: LLMProvider = {
      name: 'notefast-runtime',
      chat: (msgs, opts) => r.chat(msgs, opts),
    }
    const suggestion = await suggestTitle(provider, content)
    return c.json(suggestion)
  } catch (e) {
    return c.json({ error: 'llm_error', message: eMsg(e) }, 500)
  }
})

// ───────────────────── helpers ─────────────────────

function runtimeSafe(): boolean {
  return hasRuntime()
}

function emptyUsage() {
  return { embeddingCalls: 0, embeddingErrors: 0, chatCalls: 0, chatErrors: 0, lastSuccessAt: undefined }
}

function eMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default ai