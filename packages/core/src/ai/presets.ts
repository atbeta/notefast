/**
 * Provider 预设
 *
 * 维护常用 OpenAI 兼容服务的「一键填入」配置。
 * 永远是 freeform + preset —— AI 服务市场变化快，硬编码 enum 一年就过时。
 *
 * ## Provider 矩阵（更新于 2026-07）
 *
 * | id         | 推荐场景                         | API key 来源                                       | 计费模式         | 默认 Embedding / Chat           |
 * |------------|----------------------------------|----------------------------------------------------|------------------|---------------------------------|
 * | openai     | 官方 / 代理直连                  | https://platform.openai.com/api-keys              | 按用量           | text-embedding-3-small / gpt-4o-mini |
 * | deepseek   | 国产、纯聊天场景                 | https://platform.deepseek.com/api_keys             | 按用量，便宜     | （留空）/ deepseek-chat        |
 * | openrouter  | 1 个 key 访问多家模型            | https://openrouter.ai/keys                        | 按用量，分模型计费 | qwen/qwen3-embedding-8b / openai/gpt-4o-mini |
 * | ollama      | 完全本地、隐私场景                | 不需要 key，启动 `ollama serve` 即可             | 免费，仅自机器算力 | nomic-embed-text / llama3.2    |
 * | custom      | 任意 OpenAI 兼容服务              | 自选（vLLM / LM Studio / 智谱 / 百川 / 阿里云灵积）| 自选             | 自填                            |
 *
 * 任何字段都可以在保存之前手动覆盖；只是 PRESETS 提供合理的初始值。
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
    hint: '聚合多家模型，统一一个 Key',
    baseUrl: 'https://openrouter.ai/api/v1',
    embeddingModel: 'qwen/qwen3-embedding-8b',
    chatModel: 'openai/gpt-4o-mini',
    extraHeaders: { 'HTTP-Referer': 'https://notefast.local', 'X-Title': 'NoteFast' },
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
    hint: '任何 OpenAI 兼容服务，如 LM Studio / vLLM / 智谱 / 百川',
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
  'text-embedding-ada-002',
  'qwen/qwen3-embedding-8b',
  'nomic-embed-text',
  'mxbai-embed-large',
]

export const KNOWN_CHAT_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4-turbo',
  'deepseek-chat',
  'claude-3-5-sonnet',
  'MiniMax-M3',
  'llama3.2',
  'qwen2.5-7b-instruct',
]