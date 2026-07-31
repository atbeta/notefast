/**
 * AI 配置数据模型
 *
 * 设计原则：
 * - 单用户 + 单 active chat provider；embedding 是独立可选 provider（很多 LLM 没有 embedding 端点）
 * - 持久化：data/ai.config.json；环境变量仅在首次启动时作为种子
 * - API Key 落盘前不加密，但 maskKey() / publicView() 用于对外脱敏
 *
 * ## Chat vs Embedding 解耦
 *
 * 旧版本用 `active: { embeddingModel, chatModel, baseUrl, apiKey, ... }` 把两者强绑，
 * 但很多服务只有 chat（DeepSeek / Moonshot / Groq / xAI）或只有 embedding（Voyage / Cohere embed / Jina），
 * 所以拆成 `chat: ProviderDefinition | null` 和 `embedding: ProviderDefinition | null`。
 * 严格分离：`embedding === null` 表示禁用语义搜索，不会回退到 chat 的 baseUrl。
 */

import { PRESETS } from './presets'


export type ProviderPresetId =
  | 'siliconflow'
  | 'deepseek'
  | 'minimax'
  | 'moonshot'
  | 'openai'
  | 'openrouter'
  | 'jina'
  | 'voyage'
  | 'custom'

/** ProviderPresetId 的运行时清单：Zod schema、UI 下拉等都从这里取，避免列表漂移 */
export const PROVIDER_PRESET_IDS: readonly ProviderPresetId[] = [
  'siliconflow',
  'deepseek',
  'minimax',
  'moonshot',
  'openai',
  'openrouter',
  'jina',
  'voyage',
  'custom',
]

/** 脱敏占位符：GET /ai/config 对外返回的 apiKey 掩码 */
export const KEY_MASK = '***set***'

/**
 * 解析保存时的 apiKey：
 * - incoming 为脱敏占位符（UI 未改动 key 原样回传）→ 保留 existing（磁盘上的真实 key）
 * - 否则使用 incoming（新 key，或显式清空 ''）
 */
export function resolveApiKey(incoming: string | undefined, existing: string | undefined): string {
  if (incoming === undefined || incoming === KEY_MASK) return existing ?? ''
  return incoming.trim()
}

/** 单一 AI Provider 的完整配置 */
export interface ProviderDefinition {
  /** 唯一 id（前端 crypto.randomUUID() 生成）*/
  id: string
  /** 显示名（用户可改）*/
  label: string
  /** 预设标识，自定义为 'custom' */
  preset: ProviderPresetId
  /** OpenAI 兼容 chat/completions & embeddings 端点 */
  baseUrl: string
  /** API Key，留空表示纯本地（如 Ollama）*/
  apiKey: string
  /** Embedding 模型名；chat provider 此字段可留空；embedding provider 此字段必填 */
  embeddingModel: string
  /** Chat 模型名；chat provider 此字段必填；embedding-only provider 可留空 */
  chatModel: string
  /** 自定义请求超时（毫秒）*/
  timeoutMs: number
  /** 自定义请求头（可选，例如 OpenRouter 的 HTTP-Referer）*/
  extraHeaders: Record<string, string>
}

/** Reranker 独立配置（与 active embedding/chat provider 完全解耦）*/
export interface RerankerDefinition {
  /** 是否启用；启用时 baseUrl + model 必填 */
  enabled: boolean
  /** TEI /rerank 端点 base */
  baseUrl: string
  /** Bearer Token；本地服务可留空 */
  apiKey: string
  /** 模型名，如 BAAI/bge-reranker-v2-m3 */
  model: string
  /** 请求超时（毫秒）*/
  timeoutMs: number
}

/**
 * 自动建链：基于 Chat 模型从块内容提取锚点，高置信时直接写 block_refs（ref_type='ai_auto'）。
 * 无人工审核流程：满足阈值即建链，不满足即静默跳过。
 */
export interface AutoLinkConfig {
  /** 是否启用（note.afterCreate/Update 触发，默认开启）*/
  enabled: boolean
  /** 'all' = 任意 notebook；'same' = 同 notebook */
  notebookScope: 'all' | 'same'
  /** 每个块最多建立几条链接 */
  maxPerBlock: number
  /**
   * embedding cosine 建链门槛：
   * top-1 候选为 embedding/hybrid 且 confidence ≥ 该值才可建链；
   * FTS-only（纯字面匹配）一律不建链 —— 宁缺毋滥。
   */
  minConfidence: number
  /** top-1 与 top-2 最小差值，避免歧义候选被建链 */
  minMargin: number
  /**
   * 抽取后要丢弃的锚点类型（默认 ['tool']）：
   * 工具名 / API / 函数名 → 工具描述段落 是同义反复，不构成有效反向链接。
   */
  excludeAnchorKinds: string[]
  /**
   * true 时不链接到同一文档内的 block（默认 true）：
   * 文档内导航应交给大纲/目录，同文档互链是噪音。
   */
  excludeSelfDoc: boolean
  /**
   * 全局每分钟最多触发多少次抽取（默认 30）：
   * 批量导入/保存 burst 时超出的直接跳过（不排队），保护 chat 配额。
   */
  rateLimitPerMinute: number
}

export const DEFAULT_MAX_AUTO_LINK_PER_BLOCK = 2
/** 默认 0.6：embedding 常见命中约 0.55–0.75；0.85 会几乎永远建不出链 */
export const DEFAULT_AUTO_LINK_MIN_CONFIDENCE = 0.6
export const DEFAULT_AUTO_LINK_MIN_MARGIN = 0.15
export const DEFAULT_AUTO_LINK_EXCLUDE_KINDS: string[] = ['tool']
export const DEFAULT_AUTO_LINK_EXCLUDE_SELF_DOC = true
/** 默认 30/分钟：建链默认开启后保护 chat 配额 */
export const DEFAULT_AUTO_LINK_RATE_LIMIT_PER_MINUTE = 30

export function defaultAutoLinkConfig(): AutoLinkConfig {
  return {
    enabled: true,
    notebookScope: 'all',
    maxPerBlock: DEFAULT_MAX_AUTO_LINK_PER_BLOCK,
    minConfidence: DEFAULT_AUTO_LINK_MIN_CONFIDENCE,
    minMargin: DEFAULT_AUTO_LINK_MIN_MARGIN,
    excludeAnchorKinds: [...DEFAULT_AUTO_LINK_EXCLUDE_KINDS],
    excludeSelfDoc: DEFAULT_AUTO_LINK_EXCLUDE_SELF_DOC,
    rateLimitPerMinute: DEFAULT_AUTO_LINK_RATE_LIMIT_PER_MINUTE,
  }
}

/**
 * 完整的 AI 配置
 *
 * - `chat`：进行 chat / title / AutoLink 时使用的 provider；必填（除非完全禁用 AI）
 * - `embedding`：语义搜索 embedding 来源；可选；为 null 时只走 FTS5
 * - `reranker`：hybrid search 精排；可选；为 null 时跳过 rerank
 */
export interface AiConfig {
  /** schema 版本，便于未来迁移 */
  version: 1
  /** Chat provider（标题/摘要/对话/AutoLink 抽取使用）；null 表示 AI 完全未启用 */
  chat: ProviderDefinition | null
  /** Embedding provider（语义搜索使用，独立于 chat）；null 表示关闭 embedding */
  embedding: ProviderDefinition | null
  /** 自动索引：新建/更新 block 后是否异步生成 embedding */
  autoIndex: boolean
  /** Reranker 配置；null 表示未配置（hybrid search 跳过精排）*/
  reranker: RerankerDefinition | null
  /** 自动建链配置（默认开启；缺省时按 defaultAutoLinkConfig 处理）*/
  autoLink?: AutoLinkConfig
  /** 网页搜索配置（用于 chat 中知识库不足时联网补充）*/
  webSearch?: WebSearchConfig
  /** 图片理解：索引时用 chat 模型为图片生成描述并纳入向量检索（会产生额外 API 调用，默认关）*/
  vision?: VisionConfig
}

export interface VisionConfig {
  enabled: boolean
}

export interface WebSearchConfig {
  enabled: boolean
  apiKey: string
}

export const DEFAULT_TIMEOUT_MS = 60_000

export function emptyConfig(): AiConfig {
  return {
    version: 1,
    chat: null,
    embedding: null,
    autoIndex: true,
    reranker: null,
    autoLink: defaultAutoLinkConfig(),
  }
}

/**
 * 把 env 变量转换为初始 AiConfig（仅在 data/ai.config.json 不存在时使用）
 *
 * 解析策略：
 * 1. 若 AI_PROVIDER 是已知的 preset id（minimax / deepseek / openai / …）→ 用 preset 的 baseUrl + 默认模型
 * 2. 否则回退到 LLM_API_URL / LLM_API_KEY 等通用 env 变量，按 custom 预设处理
 * 3. EMBEDDING_PROVIDER / EMBEDDING_API_URL 控制独立 embedding 通道
 */
export function configFromEnv(env: Record<string, string | undefined>): AiConfig {
  const presetEnv = (env.AI_PROVIDER || '').trim().toLowerCase()
  const llmUrl = (env.LLM_API_URL || '').trim()
  const llmKey = (env.LLM_API_KEY || env.EMBEDDING_API_KEY || '').trim()
  const llmModel = (env.LLM_MODEL || '').trim()
  const embUrl = (env.EMBEDDING_API_URL || '').trim()
  const embKey = (env.EMBEDDING_API_KEY || '').trim()
  const embModel = (env.EMBEDDING_MODEL || '').trim()
  const embPreset = (env.EMBEDDING_PROVIDER || '').trim().toLowerCase()

  const hasChatSignal = Boolean(presetEnv || llmUrl || llmKey || llmModel)
  const hasEmbSignal = Boolean(embPreset || embUrl || embKey || embModel)
  if (!hasChatSignal && !hasEmbSignal) return emptyConfig()

  let chat: ProviderDefinition | null = null
  if (hasChatSignal) {
    let baseUrl = llmUrl
    let chatModel = llmModel
    let extraHeaders: Record<string, string> = {}
    let preset: ProviderPresetId = 'custom'
    let label = '从环境变量导入'

    if (presetEnv && PRESETS[presetEnv as ProviderPresetId]) {
      const p = PRESETS[presetEnv as ProviderPresetId]
      if (p.id !== 'custom') {
        preset = p.id
        baseUrl = baseUrl || p.baseUrl
        if (!chatModel) chatModel = p.chatModel
        extraHeaders = { ...p.extraHeaders }
        label = p.label
      }
    }
    if (!baseUrl) baseUrl = 'https://api.openai.com/v1'

    chat = {
      id: 'env-seed-chat',
      label,
      preset,
      baseUrl,
      apiKey: llmKey,
      embeddingModel: '', // chat provider 不再承担 embedding 职责
      chatModel,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      extraHeaders,
    }
  }

  let embedding: ProviderDefinition | null = null
  if (hasEmbSignal) {
    let baseUrl = embUrl
    let embeddingModel = embModel
    let extraHeaders: Record<string, string> = {}
    let preset: ProviderPresetId = 'custom'
    let label = 'Embed 从环境变量导入'

    if (embPreset && PRESETS[embPreset as ProviderPresetId]) {
      const p = PRESETS[embPreset as ProviderPresetId]
      if (p.id !== 'custom') {
        preset = p.id
        baseUrl = baseUrl || p.baseUrl
        if (!embeddingModel) embeddingModel = p.embeddingModel
        extraHeaders = { ...p.extraHeaders }
        label = `${p.label} (Embedding)`
      }
    }
    // env-seed 时若没指定 baseUrl，则用 LLM 的；都不存在就用 OpenAI 默认
    if (!baseUrl && chat) baseUrl = chat.baseUrl
    if (!baseUrl) baseUrl = 'https://api.openai.com/v1'
    if (!embeddingModel) embeddingModel = 'text-embedding-3-small'

    embedding = {
      id: 'env-seed-embedding',
      label,
      preset,
      baseUrl,
      apiKey: embKey || chat?.apiKey || '',
      embeddingModel,
      chatModel: '',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      extraHeaders,
    }
  }

  return {
    version: 1,
    chat,
    embedding,
    autoIndex: Boolean(embedding),
    reranker: rerankerFromEnv(env),
    autoLink: autoLinkFromEnv(env),
  }
}

function autoLinkFromEnv(env: Record<string, string | undefined>): AutoLinkConfig {
  // 默认开启；显式 AUTO_LINK_ENABLED=false 才关闭
  const enabled = (env.AUTO_LINK_ENABLED || 'true').toLowerCase() !== 'false'
  const scopeRaw = (env.AUTO_LINK_SCOPE || 'all').toLowerCase()
  const scope: 'all' | 'same' = scopeRaw === 'same' ? 'same' : 'all'
  const maxRaw = parseInt(env.AUTO_LINK_MAX_PER_BLOCK || '', 10)
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(maxRaw, 10) : DEFAULT_MAX_AUTO_LINK_PER_BLOCK
  const minConfRaw = parseFloat(env.AUTO_LINK_MIN_CONFIDENCE || '')
  const minConf = Number.isFinite(minConfRaw) && minConfRaw > 0 && minConfRaw <= 1
    ? minConfRaw
    : DEFAULT_AUTO_LINK_MIN_CONFIDENCE
  const minMarginRaw = parseFloat(env.AUTO_LINK_MIN_MARGIN || '')
  const minMargin = Number.isFinite(minMarginRaw) && minMarginRaw >= 0 && minMarginRaw < 1
    ? minMarginRaw
    : DEFAULT_AUTO_LINK_MIN_MARGIN
  const rateRaw = parseInt(env.AUTO_LINK_RATE_LIMIT_PER_MINUTE || '', 10)
  const rate = Number.isFinite(rateRaw) && rateRaw >= 0 ? rateRaw : DEFAULT_AUTO_LINK_RATE_LIMIT_PER_MINUTE
  return {
    enabled,
    notebookScope: scope,
    maxPerBlock: max,
    minConfidence: minConf,
    minMargin,
    excludeAnchorKinds: [...DEFAULT_AUTO_LINK_EXCLUDE_KINDS],
    excludeSelfDoc: DEFAULT_AUTO_LINK_EXCLUDE_SELF_DOC,
    rateLimitPerMinute: rate,
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
  const chat = cfg.chat
  const embedding = cfg.embedding

  // Chat provider
  if (chat) {
    if (!chat.baseUrl.trim()) errs.push('Chat provider baseUrl 不能为空')
    if (!chat.chatModel.trim()) errs.push('Chat provider 必须填写 chatModel')
    if (chat.timeoutMs < 1000 || chat.timeoutMs > 600_000) {
      errs.push('Chat provider timeoutMs 应在 1000-600000 之间')
    }
  }

  // Embedding provider（可选；但只要存在就必须填齐）
  if (embedding) {
    if (!embedding.baseUrl.trim()) errs.push('Embedding provider baseUrl 不能为空')
    if (!embedding.embeddingModel.trim()) {
      errs.push('Embedding provider 必须填写 embeddingModel')
    }
    if (embedding.timeoutMs < 1000 || embedding.timeoutMs > 600_000) {
      errs.push('Embedding provider timeoutMs 应在 1000-600000 之间')
    }
  }

  // Reranker
  const r = cfg.reranker
  if (r && r.enabled) {
    if (!r.baseUrl.trim()) errs.push('Reranker baseUrl 不能为空')
    if (!r.model.trim()) errs.push('Reranker model 不能为空')
    if (r.timeoutMs < 1000 || r.timeoutMs > 600_000) {
      errs.push('Reranker timeoutMs 应在 1000-600000 之间')
    }
  }

  // AutoLink
  const al = cfg.autoLink ?? defaultAutoLinkConfig()
  if (al.enabled && cfg.chat && !cfg.chat.chatModel.trim()) {
    errs.push('AutoLink 需要 Chat provider 已配置 chatModel')
  }
  if (al.maxPerBlock < 1 || al.maxPerBlock > 10) {
    errs.push('AutoLink maxPerBlock 应在 1-10 之间')
  }
  const VALID_KINDS = ['concept', 'tool', 'person', 'doc']
  if (!Array.isArray(al.excludeAnchorKinds) || al.excludeAnchorKinds.some((k) => !VALID_KINDS.includes(k))) {
    errs.push(`AutoLink excludeAnchorKinds 只能是 ${VALID_KINDS.join('/')} 的子集`)
  }
  if (al.rateLimitPerMinute < 0 || al.rateLimitPerMinute > 600) {
    errs.push('AutoLink rateLimitPerMinute 应在 0-600 之间（0 表示不限速）')
  }

  return errs
}

/** 脱敏 API Key：仅显示前缀和后 4 位 */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}••••${key.slice(-4)}`
}

/** 把 chat 与 embedding 的 key 置为脱敏占位符（用于对外序列化） */
export function publicView(cfg: AiConfig): AiConfig {
  let next = cfg
  if (cfg.chat) {
    next = {
      ...next,
      chat: {
        ...cfg.chat,
        apiKey: cfg.chat.apiKey ? KEY_MASK : '',
      },
    }
  }
  if (cfg.embedding) {
    next = {
      ...next,
      embedding: {
        ...cfg.embedding,
        apiKey: cfg.embedding.apiKey ? KEY_MASK : '',
      },
    }
  }
  if (cfg.reranker && cfg.reranker.apiKey) {
    next = {
      ...next,
      reranker: { ...cfg.reranker, apiKey: KEY_MASK },
    }
  }
  if (cfg.webSearch?.apiKey) {
    next = {
      ...next,
      webSearch: { ...cfg.webSearch, apiKey: KEY_MASK },
    }
  }
  return next
}
