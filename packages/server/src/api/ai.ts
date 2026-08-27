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
  type AiDiagnoseResult,
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
import {
  getRuntime,
  applyNewConfigFromCurrent,
  hasRuntime,
  loadConfigFromDisk,
} from '../services/aiRuntime'
import { indexBlock, indexAllBlocks, semanticSearch } from '../ai/indexer'
import { getVectorStore } from '../ai/vectorStore'
import { startVectorRebuild, cancelVectorRebuild } from '../ai/vectorRebuild'
import { getRebuildProgress } from '../ai/rebuildProgress'
import { startEntityRebuild, getEntityRebuildProgress, getEntityIndexState, cancelEntityRebuild } from '../ai/entityRebuild'
import { resolveAiLang } from '../ai/locale'
import { getIndexJob, getIndexJobSummary, getLatestIndexJobForDoc, pauseIndexQueue, resumeIndexQueue, scheduleDocIndex } from '../ai/indexJobs'
import { getDocIndexState, getNotebookIndexCoverage, listGapDocIds } from '../ai/docIndexState'
import { getDocById, fetchDocBlockIds } from '../store/blocks'
import { hybridSearch as hybridSearchFn } from '../ai/hybridSearch'
import { loadAiExcludedDocIds } from '../ai/aiExcludeQuery'
import { runChat, runChatSync, executeWriteTool } from '../ai/chat'
import { listSkills, parseSkillScope } from '../ai/skills'
import { streamWrite } from '../ai/writeStream'
import { getDb } from '../db'
import { runFtsQuery } from '../dbQueries'

const ai = new Hono()

const FIX_HINT = '请在 Web UI /settings 页面配置 AI Provider（API Key + Base URL + 模型名）'

// ───────────────────── status ─────────────────────

ai.get('/status', async (c) => {
  const base = await getVectorStore().status()
  const rebuild = getRebuildProgress()
  const vectorStore = rebuild ? { ...base, rebuild } : base
  // 增量索引作业汇总：语义索引面板据此展示 zip 导入等后台向量化进度
  const indexJobs = getIndexJobSummary()
  const indexCoverage = getNotebookIndexCoverage()
  if (!runtimeSafe()) {
    return c.json({ enabled: false, embedding: { configured: false, ok: false }, chat: { configured: false, ok: false }, usage: emptyUsage(), config: emptyConfig(), vectorStore, indexJobs, indexCoverage, fix_hint: FIX_HINT })
  }
  const r = getRuntime()
  const s = r.status()
  return c.json({ ...s, vectorStore, indexJobs, indexCoverage, fix_hint: s.enabled ? undefined : FIX_HINT })
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
  /** 停用开关（缺省 = 启用；false = 停用但保留配置） */
  enabled: z.boolean().optional(),
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
      preset: z.string().optional(),
    })
    .nullable()
    .optional(),
  autoLink: z
    .object({
      enabled: z.boolean(),
      maxPerBlock: z.number().int().min(1).max(10),
      minConfidence: z.number().min(0).max(1),
      minMargin: z.number().min(0).max(1),
      excludeAnchorKinds: z.array(z.enum(['concept', 'tool', 'person', 'doc'])).optional(),
      excludeSelfDoc: z.boolean().optional(),
      rateLimitPerMinute: z.number().int().min(0).max(600).optional(),
    })
    .optional(),
  webSearch: z
    .object({
      enabled: z.boolean(),
      apiKey: z.string(),
    })
    .optional(),
  vision: z
    .object({
      enabled: z.boolean(),
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
    const webSearch = body.webSearch ?? null
    if (webSearch) {
      webSearch.apiKey = resolveApiKey(webSearch.apiKey, current.webSearch?.apiKey)
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
      webSearch: webSearch && webSearch.enabled ? webSearch : undefined,
      vision: body.vision?.enabled ? { enabled: true } : undefined,
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
    const payload: AiDiagnoseResult = {
      overall: 'not_configured',
      embedding: { configured: false, ok: false, message: 'runtime 未初始化' },
      chat: { configured: false, ok: false, message: 'runtime 未初始化' },
      reranker: { configured: false, ok: false, message: 'runtime 未初始化' },
      elapsedMs: Date.now() - t0,
      ts: new Date().toISOString(),
    }
    return c.json(payload)
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
        // probeEmbeddingDim 内部吞掉异常只返回 null：必须把 lastError 透传出来，
        // 否则用户永远只看到「embedding 返回空」，真实原因（404/模型不存在/超时/格式错）无从排查
        return {
          configured: true,
          ok: false,
          latencyMs: Date.now() - t,
          error: runtime.status().embedding.lastError || 'embedding 返回空',
        }
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

  const payload: AiDiagnoseResult = {
    overall,
    embedding,
    chat,
    reranker,
    autoLink,
    elapsedMs: Date.now() - t0,
    ts: new Date().toISOString(),
  }
  return c.json(payload)
})

// ───────────────────── skills / search / index ─────────────────────

/** GET /ai/skills — 聊天预置问题；?scope=doc 当前文档 / scope=all（默认）整库 */
ai.get('/skills', (c) => {
  const lang = resolveAiLang(c.req.header('accept-language'))
  const scope = parseSkillScope(c.req.query('scope'))
  return c.json({ skills: listSkills(lang, scope) })
})

ai.get('/search', async (c) => {
  if (!runtimeSafe()) {
    return c.json({ error: 'not_configured', message: 'AI 未启用', fix_hint: FIX_HINT }, 400)
  }
  const r = getRuntime()
  const mode = (c.req.query('mode') || 'hybrid').toLowerCase()
  const q = (c.req.query('q') || '').trim()
  const limit = Math.min(parseInt(c.req.query('limit') || '10', 10) || 10, 20)
  const notebookId = c.req.query('notebook_id') || undefined
  const includeArchived = c.req.query('include_archived') === '1' || c.req.query('include_archived') === 'true'

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
      const hits = await semanticSearch(v, limit, notebookId, undefined, undefined, { includeArchived })
      return c.json(hits)
    }
    // hybrid（默认）
    const report = await hybridSearchFn({
      query: q,
      notebookId,
      topK: limit,
      includeArchived,
    })
    if (c.req.query('with_retrieval') === '1' || c.req.query('with_retrieval') === 'true') {
      return c.json(report)
    }
    return c.json(report.citations)
  } catch (e) {
    return c.json({ error: 'search_error', message: eMsg(e), fix_hint: FIX_HINT }, 500)
  }
})

function ftsHits(q: string, notebookId: string | undefined, limit: number) {
  const db = getDb()
  const { query: ftsQuery } = buildFtsQuery(q, limit)
  // 多取 3 倍，事后过滤 ai_exclude 文档后截断到 limit
  const rows = runFtsQuery(db, { match: ftsQuery, notebookId, limit, overfetch: 3 })
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
      vision: false,
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
  const status = await getVectorStore().status()
  const rebuild = getRebuildProgress()
  return c.json(rebuild ? { ...status, rebuild } : status)
})

ai.get('/index/coverage', (c) => {
  const coverage = getNotebookIndexCoverage()
  if (!coverage) return c.json({ error: 'not_configured', message: 'Embedding 未配置', fix_hint: FIX_HINT }, 400)
  return c.json(coverage)
})

ai.post('/index/gaps', (c) => {
  if (!runtimeSafe() || !getRuntime().hasEmbedding()) {
    return c.json({ error: 'not_configured', message: 'Embedding 未配置', fix_hint: FIX_HINT }, 400)
  }
  const db = getDb()
  const ids = listGapDocIds()
  let queued = 0
  for (const docId of ids) {
    const job = scheduleDocIndex(docId, fetchDocBlockIds(db, docId), { ignoreAutoIndex: true })
    if (job) queued++
  }
  return c.json({ queued, coverage: getNotebookIndexCoverage(), indexJobs: getIndexJobSummary() }, queued > 0 ? 202 : 200)
})

ai.get('/index/jobs/summary', (c) => c.json(getIndexJobSummary()))

ai.post('/index/jobs/pause', (c) => {
  pauseIndexQueue()
  return c.json(getIndexJobSummary())
})

ai.post('/index/jobs/resume', (c) => {
  resumeIndexQueue()
  return c.json(getIndexJobSummary())
})

ai.get('/index/docs/:docId', (c) => {
  const state = getDocIndexState(c.req.param('docId'))
  if (!state) return c.json({ error: 'not_found', message: '文档不存在' }, 404)
  return c.json(state)
})

ai.post('/index/docs/:docId', (c) => {
  const docId = c.req.param('docId')
  const row = getDocById(getDb(), docId)
  if (!row) return c.json({ error: 'not_found', message: '文档不存在' }, 404)
  if (!runtimeSafe() || !getRuntime().hasEmbedding()) {
    return c.json({ error: 'not_configured', message: 'Embedding 未配置', fix_hint: FIX_HINT }, 400)
  }
  const job = scheduleDocIndex(docId, fetchDocBlockIds(getDb(), docId), { ignoreAutoIndex: true })
  if (!job) return c.json({ error: 'not_configured', message: '无法调度索引作业', fix_hint: FIX_HINT }, 400)
  return c.json({ index_job: job, ...getDocIndexState(docId) }, 202)
})

ai.get('/index/jobs/:jobId', (c) => {
  const job = getIndexJob(c.req.param('jobId'))
  if (!job) return c.json({ error: 'not_found', message: '索引作业不存在' }, 404)
  return c.json(job)
})

ai.get('/index/jobs', (c) => {
  const docId = c.req.query('doc_id')
  if (!docId) return c.json({ error: 'bad_request', message: '需要 doc_id' }, 400)
  const job = getLatestIndexJobForDoc(docId)
  if (!job) return c.json({ error: 'not_found', message: '该文档暂无索引作业' }, 404)
  return c.json(job)
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

ai.post('/index/rebuild/cancel', (c) => {
  const cancelled = cancelVectorRebuild()
  if (!cancelled) return c.json({ error: 'not_running', message: '向量索引不在重建中' }, 409)
  return c.json({ cancelled: true })
})

ai.post('/entities/rebuild', async (c) => {
  if (!runtimeSafe() || !getRuntime().hasChat()) {
    return c.json({ error: 'not_configured', message: 'Chat 未配置', fix_hint: FIX_HINT }, 400)
  }
  const started = startEntityRebuild()
  if (!started) return c.json({ error: 'already_rebuilding', message: '实体图谱正在重建' }, 409)
  return c.json({ started: true }, 202)
})

ai.get('/entities/rebuild/status', (c) =>
  c.json({
    ...getEntityRebuildProgress(),
    indexState: getEntityIndexState(),
  }),
)

ai.post('/entities/rebuild/cancel', (c) => {
  const cancelled = cancelEntityRebuild()
  if (!cancelled) return c.json({ error: 'not_running', message: '实体图谱不在重建中' }, 409)
  return c.json({ cancelled: true })
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
  content: z.union([
    z.string().min(1).max(50_000),
    // 多模态（图片随 data URL 透传给视觉模型；仅在 vision 开启时由前端附加）
    z.array(
      z.union([
        z.object({ type: z.literal('text'), text: z.string().max(50_000) }),
        z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string().max(15_000_000) }) }),
      ]),
    ).min(1).max(10),
  ]),
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
  if (!hasRuntime()) return c.json({ error: 'ai_not_configured', message: '请先在设置中配置 AI provider', hint: FIX_HINT }, 503)
  const body = c.req.valid('json')
  const messages: ChatMessage[] = body.messages
  const stream = body.stream !== false // 默认 true

  if (stream) {
    return streamSSE(c, async (sse) => {
      // 心跳：首轮检索（embedding/rerank 往返）与 LLM 首 token / agent 工具轮之间
      // 可能出现 >10s 无事件的空窗，10s 一帧 ping 防止 Bun idleTimeout 与中间
      // 代理（Traefik/CF）掐断连接。前端解析时无匹配分支会自然忽略 ping 帧。
      const heartbeat = setInterval(() => {
        sse.writeSSE({ event: 'ping', data: '{}' }).catch(() => {})
      }, 10_000)
      try {
        for await (const ev of runChat({
          messages,
          contextDocId: body.context_doc_id,
          topK: body.top_k,
          ftsLimit: body.fts_limit,
          semanticLimit: body.semantic_limit,
          rerankWindow: body.rerank_window,
          temperature: body.temperature,
          maxTokens: body.max_tokens,
          lang: resolveAiLang(c.req.header('accept-language')),
          // 客户端断连 → 上游 LLM 请求随之取消（省 token；AbortError 静默）
          signal: c.req.raw.signal,
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
      } finally {
        clearInterval(heartbeat)
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
      signal: c.req.raw.signal,
    })
    return c.json(result)
  } catch (e) {
    const msg = eMsg(e)
    const code = msg.includes('[未配置]') ? 'not_configured' : 'llm_error'
    return c.json({ error: code, message: msg, fix_hint: code === 'not_configured' ? FIX_HINT : undefined }, 500)
  }
})

// ───────────────────── write-confirm ─────────────────────
// chat agent loop 现在直接执行写工具（executeWriteTool，文档历史可回退）；
// 本端点保留兼容旧客户端 / 外部调用，语义一致：校验后走同一写路径。

const writeConfirmSchema = z.object({
  tool: z.enum([
    'notefast_create_note',
    'notefast_append_to_doc',
    'notefast_update_block',
    'notefast_pin_view',
    'notefast_unpin_view',
  ]),
  args: z.record(z.string(), z.unknown()),
})

ai.post('/chat/write-confirm', zValidator('json', writeConfirmSchema), async (c) => {
  if (!runtimeSafe() || !getRuntime().hasChat()) {
    return c.json(
      { error: 'not_configured', message: 'AI chat 未配置', fix_hint: FIX_HINT },
      400,
    )
  }
  const body = c.req.valid('json')
  const result = await executeWriteTool(body.tool, body.args, {})
  if (result.resultCount === 0) {
    let err: { error?: string; message?: string } | null = null
    try { err = JSON.parse(result.content) } catch { /* ignore */ }
    return c.json({ error: 'write_failed', message: err?.message ?? err?.error ?? '写入失败' }, 400)
  }
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(result.content) } catch { /* ignore */ }
  return c.json({ ok: true, ...parsed })
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
    const suggestion = await suggestTitle(provider, content, resolveAiLang(c.req.header('accept-language')))
    return c.json(suggestion)
  } catch (e) {
    return c.json({ error: 'llm_error', message: eMsg(e) }, 500)
  }
})

// ───────────────────── write ─────────────────────

const writeSchema = z.object({
  mode: z.enum(['continue', 'refine', 'translate', 'summarize', 'expand', 'shorten']),
  content: z.string().min(1).max(100_000),
  /** 光标后正文；continue / refine 使用（加法字段，旧客户端可省略） */
  suffix: z.string().max(20_000).optional(),
  /** 选区前正文；仅 refine 使用 */
  prefix: z.string().max(20_000).optional(),
  instruction: z.string().max(200).optional(),
  target_lang: z.string().max(30).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(16).max(4096).optional(),
})

ai.post('/write', zValidator('json', writeSchema), async (c) => {
  if (!runtimeSafe() || !getRuntime().hasChat()) {
    return c.json(
      { error: 'not_configured', message: 'AI chat 未配置', fix_hint: FIX_HINT },
      400,
    )
  }
  const body = c.req.valid('json')
  return streamSSE(c, async (sse) => {
    for await (const ev of streamWrite({
      mode: body.mode,
      content: body.content,
      suffix: body.suffix,
      prefix: body.prefix,
      instruction: body.instruction,
      targetLang: body.target_lang,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      signal: c.req.raw.signal,
    })) {
      if (ev.type === 'token') {
        await sse.writeSSE({ event: 'token', data: JSON.stringify({ content: ev.content }) })
      } else if (ev.type === 'done') {
        await sse.writeSSE({ event: 'done', data: '{}' })
      } else if (ev.type === 'error') {
        await sse.writeSSE({ event: 'error', data: JSON.stringify(ev.error) })
      }
    }
  })
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