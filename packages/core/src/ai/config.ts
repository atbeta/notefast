/**
 * AI 配置数据模型
 *
 * 设计原则：
 * - 单 active 配置：NoteFast 是单 Notebook + 单用户，不存在多租户
 * - Provider 是统一抽象：一个 definition 同时描述 embedding + chat（OpenAI 兼容协议）
 * - 持久化：data/ai.config.json；环境变量仅在首次启动时作为种子
 * - API Key 落盘前不加密，但 maskKey() 用于对外脱敏（暴露最后 4 位）
 */

/** 已内置的 provider 预设（按下拉顺序排序） */
export type ProviderPresetId =
  | 'openai'
  | 'deepseek'
  | 'openrouter'
  | 'ollama'
  | 'custom'

/** 单一 AI Provider 的完整配置 */
export interface ProviderDefinition {
  /** 唯一 id（自定义 provider 时由前端生成 uuid） */
  id: string
  /** 显示名（用户可改） */
  label: string
  /** 预设标识，自定义为 'custom' */
  preset: ProviderPresetId
  /** OpenAI 兼容 chat/completions 端点 */
  baseUrl: string
  /** API Key，留空表示纯本地（如 Ollama） */
  apiKey: string
  /** Embedding 模型名；为空则禁用 embedding */
  embeddingModel: string
  /** Chat 模型名；为空则禁用 chat */
  chatModel: string
  /** 自定义请求超时（毫秒） */
  timeoutMs: number
  /** 自定义请求头（可选，例如 OpenRouter 的 HTTP-Referer） */
  extraHeaders: Record<string, string>
}

/** Reranker 独立配置（与 active embedding/chat provider 解耦） */
export interface RerankerDefinition {
  /** 是否启用；启用时 baseUrl + model 必填 */
  enabled: boolean
  /** TEI /rerank 端点 base */
  baseUrl: string
  /** Bearer Token；本地服务可留空 */
  apiKey: string
  /** 模型名，如 BAAI/bge-reranker-v2-m3 */
  model: string
  /** 请求超时（毫秒） */
  timeoutMs: number
}

/** 完整的 AI 配置（当前实现下只有一个 active provider + 可选 reranker） */
export interface AiConfig {
  /** schema 版本，便于未来迁移 */
  version: 1
  /** 当前激活的 provider；null 表示 AI 未启用 */
  active: ProviderDefinition | null
  /** 自动索引：新建/更新 block 后是否异步生成 embedding */
  autoIndex: boolean
  /** Reranker 配置；null 表示未配置（hybrid search 跳过精排） */
  reranker: RerankerDefinition | null
}

export const DEFAULT_TIMEOUT_MS = 60_000

export function emptyConfig(): AiConfig {
  return { version: 1, active: null, autoIndex: true, reranker: null }
}

/** 把 env 变量转换为初始 ProviderDefinition（仅在 data/ai.config.json 不存在时使用） */
export function configFromEnv(env: Record<string, string | undefined>): AiConfig {
  const baseUrl = (env.LLM_API_URL || '').trim()
  const apiKey = (env.LLM_API_KEY || env.EMBEDDING_API_KEY || '').trim()
  const chatModel = (env.LLM_MODEL || '').trim()
  const embeddingModel = (env.EMBEDDING_MODEL || '').trim()

  const hasAny = Boolean(baseUrl || apiKey || chatModel || embeddingModel)
  if (!hasAny) return emptyConfig()

  return {
    version: 1,
    autoIndex: true,
    active: {
      id: 'env-seed',
      label: '从环境变量导入',
      preset: 'custom',
      baseUrl: baseUrl || 'https://api.openai.com/v1',
      apiKey,
      embeddingModel,
      chatModel,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      extraHeaders: {},
    },
    reranker: rerankerFromEnv(env),
  }
}

function rerankerFromEnv(env: Record<string, string | undefined>): RerankerDefinition | null {
  const baseUrl = (env.RERANKER_API_URL || '').trim()
  const model = (env.RERANKER_MODEL || '').trim()
  if (!baseUrl || !model) return null
  return {
    enabled: true,
    baseUrl,
    apiKey: (env.RERANKER_API_KEY || '').trim(),
    model,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }
}

/** 校验配置：返回错误数组；空数组表示合法 */
export function validateConfig(cfg: AiConfig): string[] {
  const errs: string[] = []
  const a = cfg.active
  if (a) {
    if (!a.baseUrl.trim()) errs.push('Provider baseUrl 不能为空')
    if (!a.embeddingModel.trim() && !a.chatModel.trim()) {
      errs.push('Embedding 模型和 Chat 模型至少填写一个')
    }
    if (a.timeoutMs < 1000 || a.timeoutMs > 600_000) {
      errs.push('timeoutMs 应在 1000-600000 之间')
    }
  }
  const r = cfg.reranker
  if (r && r.enabled) {
    if (!r.baseUrl.trim()) errs.push('Reranker baseUrl 不能为空')
    if (!r.model.trim()) errs.push('Reranker model 不能为空')
    if (r.timeoutMs < 1000 || r.timeoutMs > 600_000) {
      errs.push('Reranker timeoutMs 应在 1000-600000 之间')
    }
  }
  return errs
}

/** 脱敏 API Key：仅显示前缀和后 4 位 */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}••••${key.slice(-4)}`
}

/** 把 active provider 与 reranker 的 key 置空（用于对外序列化） */
export function publicView(cfg: AiConfig): AiConfig {
  let next = cfg
  if (cfg.active) {
    next = { ...next, active: { ...cfg.active, apiKey: cfg.active.apiKey ? '***set***' : '' } }
  }
  if (cfg.reranker && cfg.reranker.apiKey) {
    next = {
      ...next,
      reranker: { ...cfg.reranker, apiKey: '***set***' },
    }
  }
  return next
}