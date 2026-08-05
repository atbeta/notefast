/**
 * Provider 预设
 *
 * 维护常用 OpenAI 兼容服务的「一键填入」配置。
 * 永远是 freeform + preset —— AI 服务市场变化快，硬编码 enum 一年就过时。
 *
 * ## 区域标记
 *
 * 每个预设带 `region: 'cn' | 'global' | 'local'`，仅用于 UI 分组展示，不影响实际路由。
 * 用户应自行评估网络可达性（GFW / 合规）。
 *
 * ## Provider 矩阵（2026-08 更新）
 *
 * 备注：以下默认模型是抓取自各厂商 2026-08 公开文档的最新可用 slug；
 * 如果 slug 错误或厂商微调，去 `/settings/ai` 改成任意名称即可（永远允许 freeform）。
 *
 * 区域       id            推荐场景                              默认 Embedding                  默认 Chat
 * ────────── ───────────── ──────────────────────────────────── ─────────────────────────────── ──────────────────────────────────────
 * 🇨🇳 CN    minimax       MiniMax M3 (1M context, SOTA agentic) MiniMax-Embedding-01            MiniMax-M3
 * 🇨🇳 CN    deepseek      DeepSeek V4-Flash (低价)               (空，禁用)                       deepseek-v4-flash
 * 🇨🇳 CN    doubao        字节豆包 Seed 2.1 (256K)              doubao-embedding-large          doubao-seed-2-1-pro-260628
 * 🇨🇳 CN    zhipu         智谱 GLM-5 (744B-A40B, MIT)           embedding-3                     glm-5
 * 🇨🇳 CN    moonshot      Kimi K3 长文本（kimi-latest 别名）           (空，禁用)                       kimi-latest（→K3）
 * 🇨🇳 CN    siliconflow   国产聚合 + 免费 Qwen3-Embed           Qwen/Qwen3-Embedding-8B         deepseek-ai/DeepSeek-V4-Flash（rerank: BAAI/bge-reranker-v2-m3）
 * 🇨🇳 CN    dashscope     阿里百炼 Qwen3.8-Max                  qwen3.7-text-embedding          qwen3.8-max（rerank: qwen3-rerank）
 *
 * 🌍 Global openai        官方 GPT-5.6 Terra（低延迟）               text-embedding-3-small           gpt-5.6-terra
 * 🌍 Global openrouter    1 key 访问 400+ 模型                   qwen/qwen3-embedding-8b          deepseek/deepseek-v4-flash
 * 🌍 Global gemini        Google Gemini 3.5 Flash                gemini-embedding-001             gemini-3.5-flash
 * 🌍 Global mistral       Mistral Large 3 (production)          mistral-embed                    mistral-large-latest
 * 🌍 Global groq          Groq + Qwen 3.6                       (空，禁用)                       qwen/qwen3.6-27b
 * 🌍 Global xai           Grok 4.5 frontier                     (空，禁用)                       grok-4.5
 * 🌍 Global cohere        Command A+ MoE + rerank-v4             embed-english-v3.0               command-a-plus-05-2026
 * 🌍 Global voyage        Voyage 4 (MoE flagship)                voyage-4-large                   (空，禁用) → rerank-2.5
 * 🌍 Global jina          Jina v5 text + rerank-v3               jina-embeddings-v5-text-small    (空，禁用) → jina-reranker-v3
 *
 * 🖥️ Local  ollama        本地 Ollama                            nomic-embed-text                 llama3.3
 * 🛠 自定义 custom         任意 OpenAI 兼容 (vLLM/LM Studio…)     (空)                            (空)
 */

import type { ProviderDefinition, ProviderPresetId } from './config'
import { DEFAULT_TIMEOUT_MS } from './config'

export interface ProviderPreset {
  id: ProviderPresetId
  label: string
  baseUrl: string
  embeddingModel: string
  chatModel: string
  /** Reranker 模式的默认模型（仅 supportedModes 含 'reranker' 时有意义；空 = 不预填） */
  rerankerModel: string
  extraHeaders: Record<string, string>
  requiresKey: boolean
  signupUrl?: string
  supportedModes: ('chat' | 'embedding' | 'reranker')[]
}

export const PRESETS: Record<ProviderPresetId, ProviderPreset> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    embeddingModel: '',
    chatModel: 'deepseek-v4-flash',
    rerankerModel: '',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://platform.deepseek.com/api_keys',
    supportedModes: ['chat'],
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    embeddingModel: '',
    chatModel: 'MiniMax-M3',
    rerankerModel: '',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://platform.minimaxi.com',
    supportedModes: ['chat'],
  },
  moonshot: {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    embeddingModel: '',
    chatModel: 'kimi-latest',
    rerankerModel: '',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://platform.moonshot.cn',
    supportedModes: ['chat'],
  },
  siliconflow: {
    id: 'siliconflow',
    label: 'SiliconFlow (硅基流动)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    embeddingModel: 'Qwen/Qwen3-Embedding-8B',
    chatModel: 'deepseek-ai/DeepSeek-V4-Flash',
    rerankerModel: 'BAAI/bge-reranker-v2-m3',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://cloud.siliconflow.cn',
    supportedModes: ['chat', 'embedding', 'reranker'],
  },
  dashscope: {
    id: 'dashscope',
    label: '阿里云百炼 (DashScope)',
    // OpenAI 兼容端点：chat/embeddings 走 /compatible-mode/v1；
    // qwen3-rerank 走 rerank 专属的 /compatible-api/v1/reranks（createReranker 自动替换段，见 core/reranker.ts）
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    embeddingModel: 'qwen3.7-text-embedding',
    chatModel: 'qwen3.8-max',
    rerankerModel: 'qwen3-rerank',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://bailian.console.aliyun.com/#/api-key',
    supportedModes: ['chat', 'embedding', 'reranker'],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    embeddingModel: '',
    chatModel: 'gpt-5.6-terra',
    rerankerModel: '',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://platform.openai.com/api-keys',
    supportedModes: ['chat'],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    embeddingModel: '',
    chatModel: 'deepseek/deepseek-v4-flash',
    rerankerModel: '',
    extraHeaders: { 'HTTP-Referer': 'https://notefast.local', 'X-Title': 'NoteFast' },
    requiresKey: true,
    signupUrl: 'https://openrouter.ai/keys',
    supportedModes: ['chat'],
  },
  jina: {
    id: 'jina',
    label: 'Jina AI',
    baseUrl: 'https://api.jina.ai/v1',
    embeddingModel: 'jina-embeddings-v3',
    chatModel: '',
    rerankerModel: 'jina-reranker-v3',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://jina.ai',
    supportedModes: ['embedding', 'reranker'],
  },
  voyage: {
    id: 'voyage',
    label: 'Voyage AI',
    baseUrl: 'https://api.voyageai.com/v1',
    embeddingModel: 'voyage-3',
    chatModel: '',
    rerankerModel: 'voyage-rerank-2',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://dash.voyageai.com',
    supportedModes: ['embedding', 'reranker'],
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama（本地）',
    // 必须用 OpenAI 兼容端点 /v1（/v1/embeddings、/v1/chat/completions）。
    // 不要填 /api/* 原生端点：/api/embeddings 返回 `embeddings[]` 而非 OpenAI 的 `data[]`，
    // 且 baseUrl 会被拼成 /embeddings 后缀，填完整 URL 会得到 /api/embeddings/embeddings。
    baseUrl: 'http://localhost:11434/v1',
    embeddingModel: 'nomic-embed-text',
    chatModel: 'llama3.3',
    rerankerModel: '',
    extraHeaders: {},
    requiresKey: false,
    supportedModes: ['chat', 'embedding'],
  },
  custom: {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    embeddingModel: '',
    chatModel: '',
    rerankerModel: '',
    extraHeaders: {},
    requiresKey: true,
    supportedModes: ['chat', 'embedding', 'reranker'],
  },
}

/** 根据预设生成初始 ProviderDefinition（用于 UI 选择预设时回填表单） */
export function definitionFromPreset(presetId: ProviderPresetId, apiKey = ''): ProviderDefinition {
  const p = PRESETS[presetId]
  return {
    id: crypto.randomUUID(),
    label: p.label,
    preset: presetId,
    baseUrl: p.baseUrl,
    apiKey,
    embeddingModel: p.embeddingModel,
    chatModel: p.chatModel,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    extraHeaders: { ...p.extraHeaders },
  }
}

/** 已知模型列表（用于 UI 给出下拉建议，但永远允许自定义） */
export const KNOWN_EMBEDDING_MODELS = [
  // OpenAI
  'text-embedding-3-small',
  'text-embedding-3-large',
  // Qwen
  'text-embedding-v4',
  'qwen3.7-text-embedding',
  'qwen/qwen3-embedding-8b',
  'Qwen/Qwen3-Embedding-8B',
  // Zhipu
  'embedding-3',
  // SiliconFlow BGE
  'BAAI/bge-m3',
  // Voyage (v4 系列共享向量空间)
  'voyage-4-large',
  'voyage-4',
  'voyage-4-lite',
  // Cohere
  'embed-english-v3.0',
  // Jina (v5 text-only)
  'jina-embeddings-v5-text-small',
  'jina-embeddings-v5-text-nano',
  'jina-embeddings-v4', // multimodal fallback
  // Mistral
  'mistral-embed',
  // Gemini
  'gemini-embedding-001',
  // Doubao
  'doubao-embedding-large',
  // Ollama / 本地
  'nomic-embed-text',
  'mxbai-embed-large',
  // MiniMax
  'MiniMax-Embedding-01',
]

export const KNOWN_CHAT_MODELS = [
  // OpenAI (GPT-5 系列)
  'gpt-5-mini',
  'gpt-5.4-mini',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5-nano',
  // Anthropic 没在预设里（协议不同），列出供 freeform 时参考
  'claude-sonnet-4.5',
  // Google Gemini 3.x
  'gemini-3.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  // xAI Grok
  'grok-4.5',
  'grok-4.3',
  // Mistral
  'mistral-large-latest',
  'mistral-medium-3.5',
  'mistral-medium-3-5',
  // Groq
  'qwen/qwen3.6-27b',
  'llama-4-scout',
  // DeepSeek v4
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat', // legacy alias → v4-flash
  'deepseek-reasoner', // legacy alias → v4-flash (thinking)
  // Zhipu GLM-5
  'glm-5',
  'glm-4.7-flash',
  // Moonshot Kimi
  'kimi-latest',
  'kimi-k2.6',
  // Doubao Seed 2.1
  'doubao-seed-2-1-pro-260628',
  'doubao-seed-2-1-turbo-260628',
  // DashScope Qwen3
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3-vl-plus',
  // SiliconFlow 热门
  'deepseek-ai/DeepSeek-V4-Flash',
  'deepseek-ai/DeepSeek-V4-Pro',
  'Qwen/Qwen3-235B-A22B-Instruct-2507',
  // OpenRouter
  'deepseek/deepseek-v4-flash',
  'meta-llama/llama-4-maverick',
  'meta-llama/llama-4-scout',
  'openai/gpt-oss-120b',
  // Cohere
  'command-a-plus-05-2026',
  // MiniMax
  'MiniMax-M3',
  'MiniMax-M2.7',
  // Ollama / 本地
  'llama3.3',
  'llama3.2',
]
