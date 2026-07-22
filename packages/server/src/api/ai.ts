/**
 * AI API
 *
 * 路由：
 * - GET    /api/v1/ai/status       完整状态（含 lastError / dim / usage）
 * - GET    /api/v1/ai/config       当前配置（apiKey 脱敏）
 * - PUT    /api/v1/ai/config       更新配置 + 热重载
 * - GET    /api/v1/ai/capabilities 能力发现（无 key 版本）
 * - POST   /api/v1/ai/test         连通性测试（chat + embedding + reranker）
 * - GET    /api/v1/ai/search       检索；?mode=semantic|fts|hybrid（默认 hybrid）
 * - POST   /api/v1/ai/index        全量重建索引
 * - POST   /api/v1/ai/index/:id    索引单 block
 * - POST   /api/v1/ai/suggest-title 标题/摘要生成
 * - POST   /api/v1/ai/chat         多轮对话 + RAG（SSE 事件流）
 *
 * fix_hint 约定：所有 not_configured 错误都附带 hint，引导调用方去 /settings
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { streamSSE } from 'hono/streaming'
import {
  type AiConfig,
  type ChatMessage,
  type LLMProvider,
  type ProviderPresetId,
  PROVIDER_PRESET_IDS,
  defaultAutoLinkConfig,
  emptyConfig,
  highlightSnippet,
  suggestTitle,
  buildFtsQuery,
  resolveApiKey,
  validateConfig,
} from '@notefast/core'
import type { BlockRow } from '@notefast/core'
import {
  getRuntime,
  applyNewConfigFromCurrent,
  hasRuntime,
  loadConfigFromDisk,
} from '../services/aiRuntime'
import { indexBlock, indexAllBlocks, semanticSearch } from '../ai/indexer'
import { hybridSearch as hybridSearchFn } from '../ai/hybridSearch'
import { loadAiExcludedDocIds } from '../ai/aiExclude'
import { runChat, runChatSync } from '../ai/chat'
import { getDb } from '../db'
import { getVectorStore } from '../ai/vectorStore'
import { startVectorRebuild } from '../ai/vectorRebuild'

const ai = new Hono()

const FIX_HINT = '请在 Web UI /settings 页面配置 AI Provider（API Key + Base URL + 模型名）'

// ───────────────────── status ─────────────────────

ai.get('/status', async (c) => {
  const vectorStore = await getVectorStore().status()
  if (!runtimeSafe()) {
    return c.json({ enabled: false, embedding: { configured: false, ok: false }, chat: { configured: false, ok: false }, usage: emptyUsage(), config: emptyConfig(), vectorStore, fix_hint: FIX_HINT })
  }
  const r = getRuntime()
  const s = r.status()
  return c.json({ ...s, vectorStore, fix_hint: s.enabled ? undefined : FIX_HINT })
})

// ───────────────────── config ─────────────────────

ai.get('/config', (c) => {
  if (!runtimeSafe()) return c.json(emptyConfig())
  return c.json(getRuntime().status().config)
})

const providerSchema = z.object({
  id: z.string(),
  label: z.string().min(1),
  preset: z.enum(PROVIDER_PRESET_IDS as unknown as [ProviderPresetId, ...ProviderPresetId[]]),
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  embeddingModel: z.string(),
  chatModel: z.string(),
  timeoutMs: z.number().int().min(1000).max(600_000),
  extraHeaders: z.record(z.string(), z.string()),
})

const configSchema = z.object({
  chat: providerSchema.nullable(),
  embedding: providerSchema.nullable(),
  autoIndex: z.boolean(),
  reranker: z
    .object({
      enabled: z.boolean(),
      baseUrl: z.string().min(1),
      apiKey: z.string(),
      model: z.string().min(1),
      timeoutMs: z.number().int().min(1000).max(600_000),
    })
    .nullable()
    .optional(),
  autoLink: z
    .object({
      enabled: z.boolean(),
      autoApply: z.enum(['never', 'high_confidence']),
      notebookScope: z.enum(['all', 'same']),
      maxPerBlock: z.number().int().min(1).max(10),
      minConfidence: z.number().min(0).max(1),
      minMargin: z.number().min(0).max(1),
      excludeAnchorKinds: z.array(z.enum(['concept', 'tool', 'person', 'doc'])).optional(),
      excludeSelfDoc: z.boolean().optional(),
      rateLimitPerMinute: z.number().int().min(0).max(600).optional(),
    })
    .optional(),
})

ai.put(
  '/config',
  zValidator('json', configSchema),
  async (c) => {
    if (!hasRuntime()) {
      return c.json({ error: 'internal', message: 'AI runtime 未初始化' }, 500)
    }
    const body = c.req.valid('json')
    // Key 保护：客户端回传脱敏占位符（***set***）时，保留磁盘上的真实 Key。
    // 没有这个保护的话，任何一次「改别的字段再保存」都会把真实 Key 覆盖成掩码。
    const current = loadConfigFromDisk()
    if (body.chat) {
      body.chat.apiKey = resolveApiKey(body.chat.apiKey, current.chat?.apiKey)
    }
    if (body.embedding) {
      body.embedding.apiKey = resolveApiKey(body.embedding.apiKey, current.embedding?.apiKey)
    }
    const reranker = body.reranker ?? null
    if (reranker) {
      reranker.apiKey = resolveApiKey(reranker.apiKey, current.reranker?.apiKey)
    }
    // autoLink 合并策略：磁盘现有值（含 schema 外的手加字段）→ 默认值兜底 → 请求体覆盖。
    // 防止「在 UI 改别的字段再保存」把配置文件里手加的字段物理抹掉。
    const mergedAutoLink: AiConfig['autoLink'] = {
      ...defaultAutoLinkConfig(),
      ...(current.autoLink ?? {}),
      ...(body.autoLink ?? {}),
    }
    const cfg: AiConfig = {
      version: 1,
      chat: body.chat,
      embedding: body.embedding,
      autoIndex: body.autoIndex,
      reranker: reranker && reranker.enabled ? reranker : null,
      autoLink: mergedAutoLink,
    }
    // 业务校验（chatModel / embeddingModel 必填等）→ 400
    const errors = validateConfig(cfg)
    if (errors.length > 0) {
      return c.json({ error: 'invalid_config', message: errors.join('; '), errors }, 400)
    }
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
  const chatPromise = r.hasChat() ? r.testChat() : Promise.resolve({ ok: false, message: 'Chat 未配置' as string })
  const embPromise = r.hasEmbedding() ? r.probeEmbeddingDim() : Promise.resolve(null)
  // reranker 用一个最小 payload 试一下
  const rerankPromise = r.hasReranker()
    ? r.rerank({ query: 'ping', texts: ['hello'] }).then(
        () => ({ ok: true, message: '连通正常' }),
      ).catch((e) => ({ ok: false, message: eMsg(e) }))
    : Promise.resolve({ ok: false, message: 'Reranker 未配置' })
  const [chatResult, dim, rerankResult] = await Promise.all([chatPromise, embPromise, rerankPromise])
  return c.json({
    embedding: r.hasEmbedding()
      ? { ok: dim !== null, dim, lastError: r.status().embedding.lastError }
      : { ok: false, message: 'Embedding 未配置' },
    chat: chatResult,
    reranker: rerankResult,
  })
})

// ───────────────────── diagnose / probe ─────────────────────
// 一次性探测所有已启用能力 —— chat / embedding / reranker 是否真实可达
// 比 /test 详细：含延迟、维度、错误类型；给 AutoLink / Hybrid search 排查用

ai.post('/diagnose', async (c) => {
  const t0 = Date.now()
  const runtime = hasRuntime() ? getRuntime() : null

  if (!runtime) {
    return c.json({
      overall: 'not_configured',
      embedding: { configured: false, ok: false, message: 'runtime 未初始化' },
      chat: { configured: false, ok: false, message: 'runtime 未初始化' },
      reranker: { configured: false, ok: false, message: 'runtime 未初始化' },
      elapsedMs: Date.now() - t0,
      ts: new Date().toISOString(),
    })
  }

  const cfg = runtime.autoLinkConfig()
  const status = runtime.status()

  const chatPromise = (async () => {
    if (!runtime.hasChat()) return { configured: false, ok: false, message: 'Chat 模型未配置' }
    const t = Date.now()
    try {
      const reply = await runtime.chat([
        { role: 'system', content: 'You are a connectivity probe. Reply with exactly the word "pong".' },
        { role: 'user', content: 'ping' },
      ], { maxTokens: 8, temperature: 0 })
      const out = (reply || '').trim().slice(0, 64)
      return {
        configured: true,
        ok: true,
        latencyMs: Date.now() - t,
        model: status.chat.model,
        replySample: out,
      }
    } catch (e) {
      return {
        configured: true,
        ok: false,
        latencyMs: Date.now() - t,
        model: status.chat.model,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  })()

  const embeddingPromise = (async () => {
    if (!runtime.hasEmbedding()) return { configured: false, ok: false, message: 'Embedding 模型未配置' }
    const t = Date.now()
    try {
      const dim = await runtime.probeEmbeddingDim()
      if (!dim) {
        return { configured: true, ok: false, latencyMs: Date.now() - t, error: 'embedding 返回空' }
      }
      return {
        configured: true,
        ok: true,
        latencyMs: Date.now() - t,
        dim,
        embeddingCalls: status.usage.embeddingCalls,
      }
    } catch (e) {
      return {
        configured: true,
        ok: false,
        latencyMs: Date.now() - t,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  })()

  const rerankPromise = (async () => {
    if (!runtime.hasReranker()) return { configured: false, ok: false, message: 'Reranker 未配置（hybrid search 会跳过精排步骤）' }
    const t = Date.now()
    try {
      const hits = await runtime.rerank({
        query: 'probe',
        texts: ['文档 A', '文档 B'],
        topN: 2,
      })
      return {
        configured: true,
        ok: hits.length === 2,
        latencyMs: Date.now() - t,
        model: status.reranker.model,
        hitCount: hits.length,
      }
    } catch (e) {
      return {
        configured: true,
        ok: false,
        latencyMs: Date.now() - t,
        model: status.reranker.model,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  })()

  const [chat, embedding, reranker] = await Promise.all([chatPromise, embeddingPromise, rerankPromise])

  // AutoLink 依赖项
  const autoLink = {
    configured: cfg.enabled,
    enabled: cfg.enabled,
    autoApply: cfg.autoApply,
    ok: cfg.enabled && chat.ok,
    prerequisites: {
      chat: { configured: chat.configured, ok: chat.ok },
      // embedding 不强依赖（仅 hybrid search 受益）；标记为 warning
      embedding: embedding.configured ? embedding.ok : null,
    },
  }

  // 综合判定：所有 reachable 能力都 OK
  let overall: 'healthy' | 'degraded' | 'partial' | 'idle' = 'idle'
  const reachable = [chat, embedding, reranker].filter((r) => r.configured)
  if (reachable.length === 0) {
    overall = 'idle'
  } else if (reachable.every((r) => r.ok)) {
    overall = 'healthy'
  } else if (reachable.some((r) => r.ok)) {
    overall = 'partial'
  } else {
    overall = 'degraded'
  }

  return c.json({
    overall,
    embedding,
    chat,
    reranker,
    autoLink,
    elapsedMs: Date.now() - t0,
    ts: new Date().toISOString(),
  })
})

// ───────────────────── search / index ─────────────────────

ai.get('/search', async (c) => {
  if (!runtimeSafe()) {
    return c.json({ error: 'not_configured', message: 'AI 未启用', fix_hint: FIX_HINT }, 400)
  }
  const r = getRuntime()
  const mode = (c.req.query('mode') || 'hybrid').toLowerCase()
  const q = (c.req.query('q') || '').trim()
  const limit = Math.min(parseInt(c.req.query('limit') || '10', 10) || 10, 20)
  const notebookId = c.req.query('notebook_id') || undefined

  if (!q) return c.json([])

  try {
    if (mode === 'fts') {
      const hits = ftsHits(q, notebookId, limit)
      return c.json(hits)
    }
    if (mode === 'semantic') {
      if (!r.hasEmbedding()) {
        return c.json({ error: 'not_configured', message: 'Embedding 未配置', fix_hint: FIX_HINT }, 400)
      }
      const v = await r.embedQuery(q)
      if (!v) return c.json({ error: 'embedding_failed', message: 'Embedding 返回为空' }, 500)
      const hits = await semanticSearch(v, limit, notebookId)
      return c.json(hits)
    }
    // hybrid（默认）
    const report = await hybridSearchFn({
      query: q,
      notebookId,
      topK: limit,
    })
    return c.json(report.citations)
  } catch (e) {
    return c.json({ error: 'search_error', message: eMsg(e), fix_hint: FIX_HINT }, 500)
  }
})

function ftsHits(q: string, notebookId: string | undefined, limit: number) {
  const db = getDb()
  const { query: ftsQuery } = buildFtsQuery(q, limit)
  let sql = `
    SELECT b.*, rank FROM blocks_fts f
    JOIN blocks b ON b.id = f.id
    WHERE blocks_fts MATCH ?`
  const params: (string | number)[] = [ftsQuery]
  if (notebookId) {
    sql += ' AND b.notebook_id = ?'
    params.push(notebookId)
  }
  // 多取 3 倍，事后过滤 ai_exclude 文档后截断到 limit
  sql += ' ORDER BY rank LIMIT ?'
  params.push(limit * 3)
  const rows = db.query(sql).all(...params as [string, ...(string | number)[]]) as (BlockRow & { rank: number })[]
  const excluded = loadAiExcludedDocIds(rows.map((r) => r.root_id))
  return rows
    .filter((r) => !excluded.has(r.root_id))
    .slice(0, limit)
    .map((r) => ({
      block_id: r.id,
      score: r.rank,
      content: r.content,
      doc_id: r.root_id,
      doc_title: '(FTS 命中)',
      snippet: highlightSnippet(r.content, q),
      type: r.type,
    }))
}

// ───────────────────── capabilities ─────────────────────

ai.get('/capabilities', (c) => {
  if (!runtimeSafe()) {
    return c.json({
      ai_enabled: false,
      embedding: false,
      chat: false,
      reranker: false,
      hybrid_search: true,
      external_sources: [],
    })
  }
  return c.json(getRuntime().capabilities())
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

ai.get('/index/status', async (c) => {
  return c.json(await getVectorStore().status())
})

ai.post('/index/rebuild', async (c) => {
  if (!runtimeSafe() || !getRuntime().hasEmbedding()) {
    return c.json({ error: 'not_configured', message: 'Embedding 未配置', fix_hint: FIX_HINT }, 400)
  }
  const body = await c.req.json().catch(() => ({} as { notebook_id?: string }))
  const started = startVectorRebuild({ notebookId: body.notebook_id })
  if (!started) return c.json({ error: 'already_rebuilding', message: '向量索引正在重建' }, 409)
  return c.json({ started: true }, 202)
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

// ───────────────────── chat (RAG + SSE) ─────────────────────

const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1).max(50_000),
})

const chatSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(40),
  context_doc_id: z.string().optional(),
  top_k: z.number().int().min(1).max(20).optional(),
  fts_limit: z.number().int().min(1).max(50).optional(),
  semantic_limit: z.number().int().min(1).max(50).optional(),
  rerank_window: z.number().int().min(1).max(50).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(16).max(8000).optional(),
  stream: z.boolean().optional(),
})

ai.post('/chat', zValidator('json', chatSchema), async (c) => {
  const body = c.req.valid('json')
  const messages: ChatMessage[] = body.messages
  const stream = body.stream !== false // 默认 true

  if (stream) {
    return streamSSE(c, async (sse) => {
      for await (const ev of runChat({
        messages,
        contextDocId: body.context_doc_id,
        topK: body.top_k,
        ftsLimit: body.fts_limit,
        semanticLimit: body.semantic_limit,
        rerankWindow: body.rerank_window,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
      })) {
        if (ev.type === 'retrieval') {
          await sse.writeSSE({ event: 'retrieval', data: JSON.stringify(ev.report) })
        } else if (ev.type === 'tool') {
          await sse.writeSSE({
            event: 'tool',
            data: JSON.stringify({ tool: ev.tool, args: ev.args, result_count: ev.resultCount }),
          })
        } else if (ev.type === 'reasoning') {
          await sse.writeSSE({ event: 'reasoning', data: JSON.stringify({ content: ev.content }) })
        } else if (ev.type === 'token') {
          await sse.writeSSE({ event: 'token', data: JSON.stringify({ content: ev.content }) })
        } else if (ev.type === 'done') {
          await sse.writeSSE({
            event: 'done',
            data: JSON.stringify({
              citations: ev.citations,
              retrieval: ev.retrieval,
              tool_trace: ev.toolTrace,
            }),
          })
        } else if (ev.type === 'error') {
          await sse.writeSSE({ event: 'error', data: JSON.stringify(ev.error) })
        }
      }
    })
  }

  // 非流式：用于 MCP / 简单集成
  try {
    const result = await runChatSync({
      messages,
      contextDocId: body.context_doc_id,
      topK: body.top_k,
      ftsLimit: body.fts_limit,
      semanticLimit: body.semantic_limit,
      rerankWindow: body.rerank_window,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    })
    return c.json(result)
  } catch (e) {
    const msg = eMsg(e)
    const code = msg.includes('[未配置]') ? 'not_configured' : 'llm_error'
    return c.json({ error: code, message: msg, fix_hint: code === 'not_configured' ? FIX_HINT : undefined }, 500)
  }
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
  return {
    embeddingCalls: 0,
    embeddingErrors: 0,
    chatCalls: 0,
    chatErrors: 0,
    rerankCalls: 0,
    rerankErrors: 0,
    autoLinkAnalyses: 0,
    autoLinkErrors: 0,
    lastSuccessAt: undefined,
  }
}

function eMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default ai