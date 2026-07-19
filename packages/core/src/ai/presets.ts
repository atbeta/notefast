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
 * ## Provider 矩阵（2026-07 更新）
 *
 * 备注：以下默认模型是抓取自各厂商 2026-07 公开文档的最新可用 slug；
 * 如果 slug 错误或厂商微调，去 `/settings/ai` 改成任意名称即可（永远允许 freeform）。
 *
 * 区域       id            推荐场景                              默认 Embedding                  默认 Chat                             
 * ────────── ───────────── ──────────────────────────────────── ─────────────────────────────── ──────────────────────────────────────
 * 🇨🇳 CN    minimax       MiniMax M3 (1M context, SOTA agentic) MiniMax-Embedding-01            MiniMax-M3
 * 🇨🇳 CN    deepseek      DeepSeek V4-Flash (低价)               (空，禁用)                       deepseek-v4-flash
 * 🇨🇳 CN    doubao        字节豆包 Seed 2.1 (256K)              doubao-embedding-large          doubao-seed-2-1-pro-260628
 * 🇨🇳 CN    zhipu         智谱 GLM-5 (744B-A40B, MIT)           embedding-3                     glm-5
 * 🇨🇳 CN    moonshot      Kimi K2.6 长文本                       (空，禁用)                       kimi-latest（→K2.6）
 * 🇨🇳 CN    siliconflow   国产聚合 + 免费 Qwen3-Embed           Qwen/Qwen3-Embedding-8B         deepseek-ai/DeepSeek-V4-Flash
 * 🇨🇳 CN    dashscope     阿里百炼 Qwen3.7-max                  text-embedding-v4               qwen3.7-max
 *
 * 🌍 Global openai        官方 GPT-5 mini                       text-embedding-3-small           gpt-5-mini
 * 🌍 Global openrouter    1 key 访问 400+ 模型                   qwen/qwen3-embedding-8b          meta-llama/llama-4-maverick
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

import type { ProviderDefinition, ProviderPresetId, Region } from './config'
import { DEFAULT_TIMEOUT_MS } from './config'

export interface ProviderPreset {
  id: ProviderPresetId
  label: string
  hint: string
  region: Region
  baseUrl: string
  embeddingModel: string
  chatModel: string
  extraHeaders: Record<string, string>
  /** 该预设是否需要 API Key */
  requiresKey: boolean
  /** 注册/获取 Key 的官方页面（UI 展示为链接） */
  signupUrl?: string
}

export const PRESETS: Record<ProviderPresetId, ProviderPreset> = {
  // ─────────── CN ───────────
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    hint: 'M3 1M context, MSA 架构，coding/agentic SOTA；MiniMax-Embedding-01',
    region: 'cn',
    baseUrl: 'https://api.minimaxi.com/v1',
    embeddingModel: 'MiniMax-Embedding-01',
    chatModel: 'MiniMax-M3',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://platform.minimaxi.com',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    hint: 'V4-Flash 国产低价；纯 chat，embedding 留空即可',
    region: 'cn',
    baseUrl: 'https://api.deepseek.com/v1',
    embeddingModel: '',
    chatModel: 'deepseek-v4-flash',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://platform.deepseek.com/api_keys',
  },
  doubao: {
    id: 'doubao',
    label: '字节豆包 Doubao',
    hint: 'Seed 2.1 (2026-06) 256K context，编程/Agent SOTA',
    region: 'cn',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    embeddingModel: 'doubao-embedding-large',
    chatModel: 'doubao-seed-2-1-pro-260628',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://www.volcengine.com/product/doubao',
  },
  zhipu: {
    id: 'zhipu',
    label: '智谱 GLM',
    hint: 'GLM-5（744B-A40B, MIT 开源） + embedding-3',
    region: 'cn',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    embeddingModel: 'embedding-3',
    chatModel: 'glm-5',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://open.bigmodel.cn',
  },
  moonshot: {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    hint: 'K2.6（2026-04，长上下文）；embedding 留空即可',
    region: 'cn',
    baseUrl: 'https://api.moonshot.cn/v1',
    embeddingModel: '',
    chatModel: 'kimi-latest',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://platform.moonshot.cn',
  },
  siliconflow: {
    id: 'siliconflow',
    label: 'SiliconFlow 硅基流动',
    hint: '国产聚合 + 免费 Qwen3-Embedding；托管 DeepSeek-V4 / Qwen3 / GLM-5 / Kimi-K2.6 / MiniMax-M3',
    region: 'cn',
    baseUrl: 'https://api.siliconflow.cn/v1',
    embeddingModel: 'Qwen/Qwen3-Embedding-8B',
    chatModel: 'deepseek-ai/DeepSeek-V4-Flash',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://cloud.siliconflow.cn',
  },
  dashscope: {
    id: 'dashscope',
    label: '阿里百炼 DashScope',
    hint: 'Qwen3.7-max（2026-07）+ text-embedding-v4',
    region: 'cn',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    embeddingModel: 'text-embedding-v4',
    chatModel: 'qwen3.7-max',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://bailian.console.aliyun.com',
  },

  // ─────────── Global ───────────
  openai: {
    id: 'openai',
    label: 'OpenAI',
    hint: '官方 GPT-5 mini（GPT-4o 已宣布退役）；embedding 仍用 -3-small',
    region: 'global',
    baseUrl: 'https://api.openai.com/v1',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-5-mini',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://platform.openai.com/api-keys',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: '1 key 访问 400+ 模型；默认走 Llama 4 Maverick (1M, MoE)',
    region: 'global',
    baseUrl: 'https://openrouter.ai/api/v1',
    embeddingModel: 'qwen/qwen3-embedding-8b',
    chatModel: 'meta-llama/llama-4-maverick',
    extraHeaders: { 'HTTP-Referer': 'https://notefast.local', 'X-Title': 'NoteFast' },
    requiresKey: true,
    signupUrl: 'https://openrouter.ai/keys',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    hint: 'Gemini 3.5 Flash（OpenAI 兼容端点）；国内需代理',
    region: 'global',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    embeddingModel: 'gemini-embedding-001',
    chatModel: 'gemini-3.5-flash',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://aistudio.google.com/apikey',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    hint: 'Mistral Large 3 (Apache 2.0) — `mistral-large-latest` alias；mistral-embed',
    region: 'global',
    baseUrl: 'https://api.mistral.ai/v1',
    embeddingModel: 'mistral-embed',
    chatModel: 'mistral-large-latest',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://console.mistral.ai',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    hint: 'LPU 极速推理；Qwen 3.6 27B（llama-3.3-70b 已退役）',
    region: 'global',
    baseUrl: 'https://api.groq.com/openai/v1',
    embeddingModel: '',
    chatModel: 'qwen/qwen3.6-27b',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://console.groq.com',
  },
  xai: {
    id: 'xai',
    label: 'xAI Grok',
    hint: 'Grok 4.5 frontier（2026-07，knowledge cutoff Feb 2026）；grok-2/3/4 已退役',
    region: 'global',
    baseUrl: 'https://api.x.ai/v1',
    embeddingModel: '',
    chatModel: 'grok-4.5',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://console.x.ai',
  },
  cohere: {
    id: 'cohere',
    label: 'Cohere',
    hint: 'Command A+ MoE（128K + 视觉 + 推理）+ rerank-v4.0-pro（32K）',
    region: 'global',
    baseUrl: 'https://api.cohere.com/v1',
    embeddingModel: 'embed-english-v3.0',
    chatModel: 'command-a-plus-05-2026',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://dashboard.cohere.com',
  },
  voyage: {
    id: 'voyage',
    label: 'Voyage AI',
    hint: 'voyage-4-large MoE（SOTA 检索）；rerank-2.5（32K 多语言）',
    region: 'global',
    baseUrl: 'https://api.voyageai.com/v1',
    embeddingModel: 'voyage-4-large',
    chatModel: '',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://dash.voyageai.com',
  },
  jina: {
    id: 'jina',
    label: 'Jina AI',
    hint: 'jina-embeddings-v5-text-small（v5 系列）+ jina-reranker-v3',
    region: 'global',
    baseUrl: 'https://api.jina.ai/v1',
    embeddingModel: 'jina-embeddings-v5-text-small',
    chatModel: '',
    extraHeaders: {},
    requiresKey: true,
    signupUrl: 'https://jina.ai',
  },

  // ─────────── Local ───────────
  ollama: {
    id: 'ollama',
    label: 'Ollama (本地)',
    hint: '本机 Ollama 服务，无需 API Key；推荐 llama3.3 + nomic-embed-text',
    region: 'local',
    baseUrl: 'http://localhost:11434/v1',
    embeddingModel: 'nomic-embed-text',
    chatModel: 'llama3.3',
    extraHeaders: {},
    requiresKey: false,
  },

  // ─────────── Custom ───────────
  custom: {
    id: 'custom',
    label: '自定义 (OpenAI 兼容)',
    hint: '任何 OpenAI 兼容服务，如 LM Studio / vLLM / TEI',
    region: 'local',
    baseUrl: '',
    embeddingModel: '',
    chatModel: '',
    extraHeaders: {},
    requiresKey: true,
  },
}

/** 按区域分组的预设列表（UI 下拉使用），保持 PRESETS 中的插入顺序 */
export const PRESETS_BY_REGION: Record<Region, ProviderPreset[]> = {
  cn: [],
  global: [],
  local: [],
}
for (const p of Object.values(PRESETS)) {
  PRESETS_BY_REGION[p.region].push(p)
}

/** 区域展示顺序 */
export const REGION_ORDER: Region[] = ['cn', 'global', 'local']

/** 区域中文标签 */
export const REGION_LABELS: Record<Region, string> = {
  cn: '🇨🇳 中国大陆',
  global: '🌍 全球 / 需代理',
  local: '🖥️ 本地 / 自定义',
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
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3-vl-plus',
  // SiliconFlow 热门
  'deepseek-ai/DeepSeek-V4-Flash',
  'deepseek-ai/DeepSeek-V4-Pro',
  'Qwen/Qwen3-235B-A22B-Instruct-2507',
  // OpenRouter
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
