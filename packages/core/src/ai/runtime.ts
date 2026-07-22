/**
 * AI Runtime
 *
 * 封装整个 AI 子系统的运行时状态：embedding provider、chat provider、usage、最后一次错误。
 * 单一实例（getAiRuntime() 返回同一份），支持热重载 reload(cfg)。
 *
 * 这是 AI-First 重构的核心抽象——所有 API / MCP / Web 调用都走 runtime，不直接读 env 或模块单例。
 */

import { maskKey, publicView, validateConfig } from './config'
import type { AiConfig, AutoLinkConfig, ProviderDefinition, RerankerDefinition } from './config'
import { defaultAutoLinkConfig } from './config'
import type { EmbeddingProvider, SemanticHit } from '../embedding'
import type { LLMProvider } from '../llm'
import { cosineSimilarity, truncateText } from '../embedding'
import { createTeiReranker, type RerankerProvider } from '../reranker'

/** Runtime 状态对外可序列化视图（不含原始 key） */
export interface RuntimeStatus {
  enabled: boolean
  embedding: {
    configured: boolean
    ok: boolean
    dim?: number
    lastError?: string
  }
  chat: {
    configured: boolean
    ok: boolean
    model?: string
    lastError?: string
  }
  reranker: {
    configured: boolean
    ok: boolean
    model?: string
    lastError?: string
  }
  autoLink: {
    configured: boolean
    enabled: boolean
    autoApply: 'never' | 'high_confidence'
    lastError?: string
  }
  usage: {
    embeddingCalls: number
    embeddingErrors: number
    chatCalls: number
    chatErrors: number
    rerankCalls: number
    rerankErrors: number
    autoLinkAnalyses: number
    autoLinkErrors: number
    lastSuccessAt?: string
  }
  /** 脱敏后的 provider 配置（maskKey 后的 apiKey） */
  config: AiConfig
}

/** 能力发现：UI / Agent 据此决定显示哪些入口 */
export interface Capabilities {
  ai_enabled: boolean
  embedding: boolean
  chat: boolean
  reranker: boolean
  hybrid_search: boolean
  external_sources: string[]
}

export interface AiRuntimeOptions {
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch
  /** embedding 批量大小 */
  embeddingBatchSize?: number
}

const DEFAULT_BATCH_SIZE = 20
const DEFAULT_MAX_TOKENS = 8191

export class AiRuntime {
  private cfg: AiConfig
  private embeddingProvider?: EmbeddingProvider
  private chatProvider?: LLMProvider
  private rerankerProvider?: RerankerProvider
  private embeddingDim?: number
  private fetchImpl: typeof fetch
  private batchSize: number

  // 可观测性
  private usage = {
    embeddingCalls: 0,
    embeddingErrors: 0,
    chatCalls: 0,
    chatErrors: 0,
    rerankCalls: 0,
    rerankErrors: 0,
    autoLinkAnalyses: 0,
    autoLinkErrors: 0,
    lastSuccessAt: undefined as string | undefined,
  }
  private embeddingLastError?: string
  private chatLastError?: string
  private rerankLastError?: string
  private autoLinkLastError?: string

  constructor(initial: AiConfig, opts: AiRuntimeOptions = {}) {
    this.cfg = initial
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.batchSize = opts.embeddingBatchSize ?? DEFAULT_BATCH_SIZE
    this.reload(initial, { silent: true })
  }

  /** 应用新配置；触发 provider 重建和状态校验 */
  reload(cfg: AiConfig, opts: { silent?: boolean } = {}): { ok: boolean; errors: string[] } {
    const errors = validateConfig(cfg)
    this.cfg = cfg
    this.embeddingProvider = undefined
    this.chatProvider = undefined
    this.rerankerProvider = undefined
    this.embeddingDim = undefined
    this.embeddingLastError = undefined
    this.chatLastError = undefined
    this.rerankLastError = undefined

    if (cfg.embedding) {
      const e = cfg.embedding
      if (e.embeddingModel.trim()) {
        this.embeddingProvider = createEmbeddingProvider(e, this.fetchImpl, this.batchSize)
      }
    }

    if (cfg.chat) {
      const c = cfg.chat
      if (c.chatModel.trim()) {
        this.chatProvider = createChatProvider(c, this.fetchImpl)
      }
    }

    if (cfg.reranker && cfg.reranker.enabled) {
      this.rerankerProvider = createTeiReranker(
        cfg.reranker.baseUrl,
        cfg.reranker.model,
        this.fetchImpl,
        cfg.reranker.timeoutMs,
        cfg.reranker.apiKey,
      )
    }

    if (!opts.silent) {
      const parts: string[] = []
      if (this.embeddingProvider) parts.push(`embedding=${cfg.embedding!.embeddingModel}@${labelOf(cfg.embedding!)}`)
      if (this.chatProvider) parts.push(`chat=${cfg.chat!.chatModel}@${labelOf(cfg.chat!)}`)
      if (this.rerankerProvider) parts.push(`reranker=${cfg.reranker!.model}`)
      console.log(`🧠 AI: ${parts.length ? parts.join(', ') : 'disabled'}`)
    }

    return { ok: errors.length === 0, errors }
  }

  /** 获取对外可序列化的状态（含脱敏 key） */
  status(): RuntimeStatus {
    const c = this.cfg.chat
    const e = this.cfg.embedding
    const r = this.cfg.reranker
    return {
      enabled: Boolean(c || e),
      embedding: {
        configured: Boolean(e?.embeddingModel.trim()),
        ok: Boolean(this.embeddingProvider) && !this.embeddingLastError,
        dim: this.embeddingDim,
        lastError: this.embeddingLastError,
      },
      chat: {
        configured: Boolean(c?.chatModel.trim()),
        ok: Boolean(this.chatProvider) && !this.chatLastError,
        model: c?.chatModel || undefined,
        lastError: this.chatLastError,
      },
      reranker: {
        configured: Boolean(r && r.enabled),
        ok: Boolean(this.rerankerProvider) && !this.rerankLastError,
        model: r?.model || undefined,
        lastError: this.rerankLastError,
      },
      autoLink: {
        configured: Boolean(this.cfg.autoLink?.enabled) && Boolean(c?.chatModel.trim()),
        enabled: Boolean(this.cfg.autoLink?.enabled),
        autoApply: this.cfg.autoLink?.autoApply ?? 'never',
        lastError: this.autoLinkLastError,
      },
      usage: { ...this.usage },
      config: publicView(this.cfg),
    }
  }

  /** 获取当前能力清单（无 key 版本） */
  capabilities(): Capabilities {
    const hasEmb = this.hasEmbedding()
    const hasChat = this.hasChat()
    const hasRerank = this.hasReranker()
    return {
      ai_enabled: Boolean(this.cfg.chat || this.cfg.embedding),
      embedding: hasEmb,
      chat: hasChat,
      reranker: hasRerank,
      // 至少有 embedding 或 FTS5 之一（后者始终可用）即为真；为简洁，恒 true 表示"检索可用"
      hybrid_search: true,
      external_sources: [],
    }
  }

  /** 暴露当前 chat provider 配置（未启用时为 null） */
  chatProviderDef(): ProviderDefinition | null {
    return this.cfg.chat
  }

  /** 暴露当前 embedding provider 配置（未配置时为 null） */
  embeddingProviderDef(): ProviderDefinition | null {
    return this.cfg.embedding
  }

  /** 暴露当前 reranker 配置（用于 UI 脱敏展示） */
  rerankerConfig(): RerankerDefinition | null {
    return this.cfg.reranker
  }

  hasEmbedding(): boolean {
    return Boolean(this.embeddingProvider)
  }

  hasChat(): boolean {
    return Boolean(this.chatProvider)
  }

  hasReranker(): boolean {
    return Boolean(this.rerankerProvider)
  }

  /** 替换 fetch 实现（测试和自定义代理场景使用） */
  setFetchImpl(impl: typeof fetch): void {
    this.fetchImpl = impl
    // 重建 provider，使新 fetch 生效
    if (this.cfg.chat || this.cfg.embedding || this.cfg.reranker) {
      this.reload(this.cfg, { silent: true })
    }
  }

  async embedQuery(text: string): Promise<Float64Array | null> {
    if (!this.embeddingProvider) return null
    try {
      const v = await this.embeddingProvider.embedQuery(text)
      this.usage.embeddingCalls++
      this.usage.lastSuccessAt = new Date().toISOString()
      this.embeddingLastError = undefined
      this.embeddingDim = v.length
      return v
    } catch (e) {
      this.usage.embeddingErrors++
      this.embeddingLastError = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  async embedBatch(texts: string[]): Promise<Array<Float64Array>> {
    if (!this.embeddingProvider) return []
    try {
      const v = await this.embeddingProvider.embedBatch(texts)
      this.usage.embeddingCalls++
      this.usage.lastSuccessAt = new Date().toISOString()
      this.embeddingLastError = undefined
      this.embeddingDim = v[0]?.length
      return v
    } catch (e) {
      this.usage.embeddingErrors++
      this.embeddingLastError = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  async chat(messages: import('../llm').ChatMessage[], options?: import('../llm').ChatCompletionOptions): Promise<string> {
    if (!this.chatProvider) {
      const err = new Error('AI chat is not configured')
      this.chatLastError = err.message
      throw err
    }
    try {
      const r = await this.chatProvider.chat(messages, options)
      this.usage.chatCalls++
      this.usage.lastSuccessAt = new Date().toISOString()
      this.chatLastError = undefined
      return r
    } catch (e) {
      this.usage.chatErrors++
      this.chatLastError = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  /**
   * 支持 tool call 的 chat（agent loop 用）。
   * 若 provider 未实现 chatWithTools，返回 null（调用方降级为流式）。
   */
  async chatWithTools(
    messages: import('../llm').ChatMessage[],
    options?: import('../llm').ChatWithToolsOptions,
  ): Promise<import('../llm').ChatWithToolsResult | null> {
    if (!this.chatProvider || typeof this.chatProvider.chatWithTools !== 'function') {
      return null
    }
    try {
      const r = await this.chatProvider.chatWithTools(messages, options)
      this.usage.chatCalls++
      this.usage.lastSuccessAt = new Date().toISOString()
      this.chatLastError = undefined
      return r
    } catch (e) {
      this.usage.chatErrors++
      this.chatLastError = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  /**
   * 流式聊天：返回 AsyncIterable<StreamChatChunk>。
   * 内部走 OpenAI 兼容 stream=true，解析 SSE 数据帧。
   * 同时读取 content 与 reasoning（reasoning_content / reasoning / thinking）。
   */
  async *streamChat(
    messages: import('../llm').ChatMessage[],
    options?: import('../llm').ChatCompletionOptions,
  ): AsyncGenerator<import('../llm').StreamChatChunk> {
    if (!this.chatProvider) {
      this.chatLastError = 'AI chat is not configured'
      throw new Error(this.chatLastError)
    }
    const p = this.cfg.chat
    if (!p) {
      this.chatLastError = 'AI chat provider is not configured'
      throw new Error(this.chatLastError)
    }
    yield* this.streamCompletions(messages, {
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      model: options?.model,
      responseFormat: options?.responseFormat,
    })
  }

  /**
   * 流式 + tools：边收 token/reasoning，结束时带回累计 tool_calls。
   * agent loop 用此方法实现真流式最终答案，同时保留 tool-call。
   */
  async *streamChatWithTools(
    messages: import('../llm').ChatMessage[],
    options?: import('../llm').ChatWithToolsOptions,
  ): AsyncGenerator<import('../llm').StreamChatChunk> {
    if (!this.chatProvider) {
      this.chatLastError = 'AI chat is not configured'
      throw new Error(this.chatLastError)
    }
    const p = this.cfg.chat
    if (!p) {
      this.chatLastError = 'AI chat provider is not configured'
      throw new Error(this.chatLastError)
    }
    yield* this.streamCompletions(messages, {
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      model: options?.model,
      responseFormat: options?.responseFormat,
      tools: options?.tools,
    })
  }

  /** 底层 SSE 解析（可选 tools） */
  private async *streamCompletions(
    messages: import('../llm').ChatMessage[],
    options: {
      temperature?: number
      maxTokens?: number
      model?: string
      responseFormat?: import('../llm').ResponseFormat
      tools?: import('../llm').ToolDefinition[]
    },
  ): AsyncGenerator<import('../llm').StreamChatChunk> {
    const p = this.cfg.chat!
    const url = joinUrl(p.baseUrl, '/chat/completions')
    const headers = buildHeaders(p)
    const model = options.model || p.chatModel.trim()
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), p.timeoutMs)
    const toolAcc = new Map<number, { id: string; name: string; arguments: string }>()
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens ?? 2000,
          ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
          ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
        }),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) {
        const err = await res.text().catch(() => '')
        throw new Error(`LLM stream ${res.status}: ${err.slice(0, 300)}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const finish = (): import('../llm').StreamChatChunk => {
        this.usage.chatCalls++
        this.usage.lastSuccessAt = new Date().toISOString()
        this.chatLastError = undefined
        const tool_calls = [...toolAcc.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, tc]) => ({
            id: tc.id,
            name: tc.name,
            args: safeJsonParse(tc.arguments),
          }))
          .filter((tc) => tc.name)
        return { content: '', done: true, ...(tool_calls.length > 0 ? { tool_calls } : {}) }
      }
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trimEnd()
          buf = buf.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            yield finish()
            return
          }
          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{
                delta?: {
                  content?: string | null
                  reasoning_content?: string | null
                  reasoning?: string | null
                  thinking?: string | null
                  tool_calls?: Array<{
                    index?: number
                    id?: string
                    type?: string
                    function?: { name?: string; arguments?: string }
                  }>
                }
              }>
            }
            const delta = json.choices?.[0]?.delta
            if (!delta) continue
            const reasoning =
              delta.reasoning_content || delta.reasoning || delta.thinking || undefined
            if (reasoning) yield { reasoning }
            if (delta.content) yield { content: delta.content }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const index = tc.index ?? 0
                const prev = toolAcc.get(index) ?? { id: '', name: '', arguments: '' }
                if (tc.id) prev.id = tc.id
                if (tc.function?.name) prev.name = tc.function.name
                if (tc.function?.arguments) prev.arguments += tc.function.arguments
                toolAcc.set(index, prev)
              }
            }
          } catch {
            // 忽略无法解析的行（OpenAI 偶尔会发 keep-alive 注释）
          }
        }
      }
      yield finish()
    } catch (e) {
      this.usage.chatErrors++
      this.chatLastError = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  /** 调用 reranker；未配置时抛出 */
  async rerank(input: import('../reranker').RerankInput): Promise<import('../reranker').RerankHit[]> {
    if (!this.rerankerProvider) {
      const err = new Error('Reranker is not configured')
      this.rerankLastError = err.message
      throw err
    }
    try {
      const r = await this.rerankerProvider.rerank(input)
      this.usage.rerankCalls++
      this.usage.lastSuccessAt = new Date().toISOString()
      this.rerankLastError = undefined
      return r
    } catch (e) {
      this.usage.rerankErrors++
      this.rerankLastError = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  /** 当前 AutoLink 配置（用于 UI 展示 & 测试） */
  autoLinkConfig(): AutoLinkConfig {
    return this.cfg.autoLink ?? defaultAutoLinkConfig()
  }

  /** 标记一次 AutoLink 分析成功/失败（由 server/ai/autoLink 调用） */
  recordAutoLink(success: boolean, err?: string): void {
    this.usage.autoLinkAnalyses++
    if (success) {
      this.autoLinkLastError = undefined
      this.usage.lastSuccessAt = new Date().toISOString()
    } else {
      this.usage.autoLinkErrors++
      this.autoLinkLastError = err
    }
  }

  /** 探测维度（向 embedding 模型发一次 dummy 请求） */
  async probeEmbeddingDim(): Promise<number | null> {
    if (!this.embeddingProvider) return null
    try {
      const v = await this.embeddingProvider.embedQuery('dimension probe')
      const dim = v.length
      this.embeddingDim = dim
      return dim
    } catch (e) {
      this.embeddingLastError = e instanceof Error ? e.message : String(e)
      return null
    }
  }

  /** 用配置中的 chat 模型发一条最小请求，验证连通性 */
  async testChat(): Promise<{ ok: boolean; message: string }> {
    if (!this.chatProvider) {
      return { ok: false, message: 'Chat 模型未配置' }
    }
    try {
      const reply = await this.chatProvider.chat(
        [{ role: 'user', content: 'ping' }],
        { temperature: 0, maxTokens: 8 },
      )
      return { ok: true, message: `连通正常 (${reply.slice(0, 30)}…)` }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.chatLastError = msg
      return { ok: false, message: msg }
    }
  }
}

// ───────────────────── Provider 工厂（OpenAI 兼容统一实现）─────────────────────

function createEmbeddingProvider(
  p: ProviderDefinition,
  fetchImpl: typeof fetch,
  batchSize: number,
): EmbeddingProvider {
  const url = joinUrl(p.baseUrl, '/embeddings')
  const headers = buildHeaders(p)
  const model = p.embeddingModel.trim()
  const maxTokens = DEFAULT_MAX_TOKENS

  return {
    name: 'openai-embed-' + model,
    batchSize,
    maxTokens,
    async embedBatch(texts: string[]): Promise<Array<Float64Array>> {
      const truncated = texts.map((t) => truncateText(t, maxTokens))
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input: truncated }),
      })
      if (!res.ok) {
        const err = await res.text().catch(() => '')
        throw new Error(`Embedding API ${res.status}: ${err.slice(0, 300)}`)
      }
      const json = (await res.json()) as { data: Array<{ embedding: number[] }> }
      return json.data.map((item) => new Float64Array(item.embedding))
    },
    async embedQuery(text: string): Promise<Float64Array> {
      const arr = await this.embedBatch([text])
      if (!arr[0]) throw new Error('Embedding 返回为空')
      return arr[0]
    },
  }
}

function createChatProvider(p: ProviderDefinition, fetchImpl: typeof fetch): LLMProvider {
  const url = joinUrl(p.baseUrl, '/chat/completions')
  const headers = buildHeaders(p)
  const model = p.chatModel.trim()

  return {
    name: 'openai-chat-' + model,
    async chat(messages, options) {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), p.timeoutMs)
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: options?.model || model,
            messages,
            temperature: options?.temperature ?? 0.3,
            max_tokens: options?.maxTokens ?? 200,
            ...(options?.responseFormat ? { response_format: options.responseFormat } : {}),
          }),
          signal: ac.signal,
        })
        if (!res.ok) {
          const err = await res.text().catch(() => '')
          throw new Error(`LLM API ${res.status}: ${err.slice(0, 300)}`)
        }
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        return json.choices?.[0]?.message?.content || ''
      } finally {
        clearTimeout(t)
      }
    },
    async chatWithTools(messages, options) {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), p.timeoutMs)
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: options?.model || model,
            messages,
            temperature: options?.temperature ?? 0.3,
            max_tokens: options?.maxTokens ?? 2000,
            ...(options?.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
            ...(options?.responseFormat ? { response_format: options.responseFormat } : {}),
          }),
          signal: ac.signal,
        })
        if (!res.ok) {
          const err = await res.text().catch(() => '')
          throw new Error(`LLM API ${res.status}: ${err.slice(0, 300)}`)
        }
        const json = (await res.json()) as {
          choices?: Array<{
            message?: {
              content?: string | null
              reasoning_content?: string | null
              reasoning?: string | null
              tool_calls?: Array<{
                id: string
                type: 'function'
                function: { name: string; arguments: string }
              }>
            }
            finish_reason?: string
          }>
        }
        const msg = json.choices?.[0]?.message
        const content = msg?.content ?? ''
        const reasoning = msg?.reasoning_content || msg?.reasoning || undefined
        const toolCalls = (msg?.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          args: safeJsonParse(tc.function.arguments),
        }))
        return { content, tool_calls: toolCalls, ...(reasoning ? { reasoning } : {}) }
      } finally {
        clearTimeout(t)
      }
    },
  }
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function buildHeaders(p: ProviderDefinition): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (p.apiKey.trim()) h['Authorization'] = `Bearer ${p.apiKey.trim()}`
  for (const [k, v] of Object.entries(p.extraHeaders)) {
    if (k && v) h[k] = v
  }
  return h
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : '/' + path
  return b + p
}

/** 用于日志的 provider 简短标签（host 或 label） */
function labelOf(p: ProviderDefinition): string {
  try {
    const u = new URL(p.baseUrl)
    return u.host
  } catch {
    return p.label || p.baseUrl
  }
}

// ───────────────────── 全局单例 ─────────────────────

let runtime: AiRuntime | null = null

export function setAiRuntime(r: AiRuntime): void {
  runtime = r
}

export function getAiRuntime(): AiRuntime {
  if (!runtime) throw new Error('AiRuntime 未初始化')
  return runtime
}

export function hasAiRuntime(): boolean {
  return runtime !== null
}

export function resetAiRuntimeForTests(): void {
  runtime = null
}

// 重导出方便外部使用
export { cosineSimilarity, truncateText, maskKey }
export type { SemanticHit }