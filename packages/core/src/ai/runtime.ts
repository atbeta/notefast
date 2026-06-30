/**
 * AI Runtime
 *
 * 封装整个 AI 子系统的运行时状态：embedding provider、chat provider、usage、最后一次错误。
 * 单一实例（getAiRuntime() 返回同一份），支持热重载 reload(cfg)。
 *
 * 这是 AI-First 重构的核心抽象——所有 API / MCP / Web 调用都走 runtime，不直接读 env 或模块单例。
 */

import { maskKey, publicView, validateConfig } from './config'
import type { AiConfig, ProviderDefinition } from './config'
import type { EmbeddingProvider, SemanticHit } from '../embedding'
import type { LLMProvider } from '../llm'
import { cosineSimilarity, truncateText } from '../embedding'

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
  usage: {
    embeddingCalls: number
    embeddingErrors: number
    chatCalls: number
    chatErrors: number
    lastSuccessAt?: string
  }
  /** 脱敏后的 provider 配置（maskKey 后的 apiKey） */
  config: AiConfig
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
  private embeddingDim?: number
  private fetchImpl: typeof fetch
  private batchSize: number

  // 可观测性
  private usage = {
    embeddingCalls: 0,
    embeddingErrors: 0,
    chatCalls: 0,
    chatErrors: 0,
    lastSuccessAt: undefined as string | undefined,
  }
  private embeddingLastError?: string
  private chatLastError?: string

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
    this.embeddingDim = undefined
    this.embeddingLastError = undefined
    this.chatLastError = undefined

    if (!cfg.active) {
      if (!opts.silent) console.log('🧠 AI: disabled')
      return { ok: true, errors }
    }

    const p = cfg.active
    const hasEmbedding = Boolean(p.embeddingModel.trim())
    const hasChat = Boolean(p.chatModel.trim())

    if (hasEmbedding) {
      this.embeddingProvider = createEmbeddingProvider(p, this.fetchImpl, this.batchSize)
    }
    if (hasChat) {
      this.chatProvider = createChatProvider(p, this.fetchImpl)
    }

    if (!opts.silent) {
      const parts: string[] = []
      if (hasEmbedding) parts.push(`embedding=${p.embeddingModel}`)
      if (hasChat) parts.push(`chat=${p.chatModel}`)
      console.log(`🧠 AI: ${parts.join(', ')} @ ${p.baseUrl}`)
    }

    return { ok: errors.length === 0, errors }
  }

  /** 获取对外可序列化的状态（含脱敏 key） */
  status(): RuntimeStatus {
    const a = this.cfg.active
    return {
      enabled: Boolean(a),
      embedding: {
        configured: Boolean(a?.embeddingModel.trim()),
        ok: Boolean(this.embeddingProvider) && !this.embeddingLastError,
        dim: this.embeddingDim,
        lastError: this.embeddingLastError,
      },
      chat: {
        configured: Boolean(a?.chatModel.trim()),
        ok: Boolean(this.chatProvider) && !this.chatLastError,
        model: a?.chatModel || undefined,
        lastError: this.chatLastError,
      },
      usage: { ...this.usage },
      config: publicView(this.cfg),
    }
  }

  /** 暴露当前 active provider（未启用时为 null） */
  activeProvider(): ProviderDefinition | null {
    return this.cfg.active
  }

  hasEmbedding(): boolean {
    return Boolean(this.embeddingProvider)
  }

  hasChat(): boolean {
    return Boolean(this.chatProvider)
  }

  /** 替换 fetch 实现（测试和自定义代理场景使用） */
  setFetchImpl(impl: typeof fetch): void {
    this.fetchImpl = impl
    // 重建 provider，使新 fetch 生效
    if (this.cfg.active) {
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