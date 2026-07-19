/**
 * Provider 预设
 *
 * 维护常用 OpenAI 兼容服务的「一键填入」配置。
 * 永远是 freeform + preset —— AI 服务市场变化快，硬编码 enum 一年就过时。
 *
 * ## 泛用实现说明
 *
 * 所有预设都走 **OpenAI 兼容协议**（/chat/completions + /embeddings）——
 * 这是当前事实上的行业通用接口（LiteLLM / LibreChat / OpenRouter 同款思路）：
 * 一个协议实现覆盖所有供应商，新增供应商只需加一行预设（baseUrl + 模型名）。
 *
 * ## Provider 矩阵（更新于 2026-07）
 *
 * | id          | 推荐场景                       | API key 来源                              | 默认 Embedding / Chat                  |
 * |-------------|-------------------------------|-------------------------------------------|----------------------------------------|
 * | openai      | 官方 / 代理直连                | platform.openai.com/api-keys              | text-embedding-3-small / gpt-4o-mini   |
 * | deepseek    | 国产高性价比纯聊天              | platform.deepseek.com/api_keys            | （无 embedding API）/ deepseek-chat     |
 * | openrouter  | 1 个 key 访问 100+ 家模型      | openrouter.ai/keys                        | qwen/qwen3-embedding-8b / openai/gpt-4o-mini |
 * | siliconflow | 国产聚合，免费 bge embedding   | cloud.siliconflow.cn                      | BAAI/bge-m3 / deepseek-ai/DeepSeek-V3  |
 * | zhipu       | 智谱 GLM，国产 embedding       | open.bigmodel.cn                          | embedding-3 / glm-4.5-air              |
 * | moonshot    | Kimi K2 长文本                 | platform.moonshot.cn                      | （无 embedding API）/ kimi-k2-0711-preview |
 * | dashscope   | 阿里百炼，qwen 全家桶           | bailian.console.aliyun.com                | text-embedding-v4 / qwen-plus          |
 * | gemini      | Google Gemini OpenAI 兼容端点   | aistudio.google.com/apikey                | gemini-embedding-001 / gemini-2.5-flash |
 * | ollama      | 完全本地、隐私场景               | 不需要 key                                | nomic-embed-text / llama3.2            |
 * | custom      | 任意 OpenAI 兼容服务            | 自选（vLLM / LM Studio / TEI …）          | 自填                                   |
 */

import type { ProviderDefinition, ProviderPresetId } from './config'
import { DEFAULT_TIMEOUT_MS } from './config'

export interface ProviderPreset {
  id: ProviderPresetId
  label: string
  hint: string
  baseUrl: string
  embeddingModel: string
  chatModel: string
  extraHeaders: Record<string, string>
  /** 该预设是否需要 API Key */
  requiresKey: boolean
}

export const PRESETS: Record<ProviderPresetId, ProviderPreset> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    hint: '官方 OpenAI API，国内需代理',
    baseUrl: 'https://api.openai.com/v1',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    extraHeaders: {},
    requiresKey: true,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    hint: '国产高性价比，仅 chat；embedding 留空即可',
    baseUrl: 'https://api.deepseek.com/v1',
    embeddingModel: '',
    chatModel: 'deepseek-chat',
    extraHeaders: {},
    requiresKey: true,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: '聚合 100+ 家模型，统一一个 Key',
    baseUrl: 'https://openrouter.ai/api/v1',
    embeddingModel: 'qwen/qwen3-embedding-8b',
    chatModel: 'openai/gpt-4o-mini',
    extraHeaders: { 'HTTP-Referer': 'https://notefast.local', 'X-Title': 'NoteFast' },
    requiresKey: true,
  },
  siliconflow: {
    id: 'siliconflow',
    label: 'SiliconFlow 硅基流动',
    hint: '国产聚合，bge embedding/reranker 免费，托管 DeepSeek/Qwen/GLM/Kimi',
    baseUrl: 'https://api.siliconflow.cn/v1',
    embeddingModel: 'BAAI/bge-m3',
    chatModel: 'deepseek-ai/DeepSeek-V3',
    extraHeaders: {},
    requiresKey: true,
  },
  zhipu: {
    id: 'zhipu',
    label: '智谱 GLM',
    hint: 'GLM-4.5 系列 + 国产 embedding-3',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    embeddingModel: 'embedding-3',
    chatModel: 'glm-4.5-air',
    extraHeaders: {},
    requiresKey: true,
  },
  moonshot: {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    hint: 'K2 长文本聊天，仅 chat；embedding 留空即可',
    baseUrl: 'https://api.moonshot.cn/v1',
    embeddingModel: '',
    chatModel: 'kimi-k2-0711-preview',
    extraHeaders: {},
    requiresKey: true,
  },
  dashscope: {
    id: 'dashscope',
    label: '阿里百炼 DashScope',
    hint: 'Qwen 全家桶 + text-embedding-v4',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    embeddingModel: 'text-embedding-v4',
    chatModel: 'qwen-plus',
    extraHeaders: {},
    requiresKey: true,
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    hint: 'OpenAI 兼容端点；国内需代理',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    embeddingModel: 'gemini-embedding-001',
    chatModel: 'gemini-2.5-flash',
    extraHeaders: {},
    requiresKey: true,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (本地)',
    hint: '本机 Ollama 服务，无需 API Key',
    baseUrl: 'http://localhost:11434/v1',
    embeddingModel: 'nomic-embed-text',
    chatModel: 'llama3.2',
    extraHeaders: {},
    requiresKey: false,
  },
  custom: {
    id: 'custom',
    label: '自定义 (OpenAI 兼容)',
    hint: '任何 OpenAI 兼容服务，如 LM Studio / vLLM / TEI',
    baseUrl: '',
    embeddingModel: '',
    chatModel: '',
    extraHeaders: {},
    requiresKey: true,
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
  'text-embedding-3-small',
  'text-embedding-3-large',
  'BAAI/bge-m3',
  'embedding-3',
  'text-embedding-v4',
  'qwen/qwen3-embedding-8b',
  'gemini-embedding-001',
  'nomic-embed-text',
  'mxbai-embed-large',
]

export const KNOWN_CHAT_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4.1',
  'gpt-4.1-mini',
  'deepseek-chat',
  'deepseek-reasoner',
  'glm-4.5',
  'glm-4.5-air',
  'kimi-k2-0711-preview',
  'moonshot-v1-8k',
  'qwen-plus',
  'qwen-turbo',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'llama3.2',
]