/**
 * AI Provider 预设
 *
 * 一行 AI_API_KEY 即可启用，模型/URL 自动对齐。
 * 所有 provider 走 OpenAI 兼容 API，零额外代码。
 *
 * 预设：
 *   openrouter  — OpenRouter（Minimax / DeepSeek / 任意）
 *   zhipu       — 智谱 GLM（国内直达）
 *   qwen        — 阿里通义（国内直达）
 *   custom      — 手动指定全部参数
 */

export interface ProviderPreset {
  label: string
  embeddingUrl: string
  embeddingModel: string
  chatUrl: string
  chatModel: string
}

const presets: Record<string, ProviderPreset> = {
  openrouter: {
    label: 'OpenRouter',
    embeddingUrl: 'https://openrouter.ai/api/v1/embeddings',
    embeddingModel: 'openai/text-embedding-3-small',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    chatModel: 'minimax/minimax-01',
  },
  zhipu: {
    label: '智谱 GLM',
    embeddingUrl: 'https://open.bigmodel.cn/api/paas/v4/embeddings',
    embeddingModel: 'embedding-2',
    chatUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    chatModel: 'glm-4-flash',
  },
  qwen: {
    label: '阿里通义',
    embeddingUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
    embeddingModel: 'text-embedding-v3',
    chatUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    chatModel: 'qwen-plus',
  },
  custom: {
    label: '自定义',
    embeddingUrl: '',
    embeddingModel: '',
    chatUrl: '',
    chatModel: '',
  },
}

export function resolvePreset(name?: string): ProviderPreset | null {
  const key = (name || 'openrouter').toLowerCase()
  const preset = presets[key]
  if (!preset) return null

  if (key === 'custom') {
    return {
      label: '自定义',
      embeddingUrl: process.env.EMBEDDING_API_URL || '',
      embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      chatUrl: process.env.LLM_API_URL || '',
      chatModel: process.env.LLM_MODEL || 'gpt-4o-mini',
    }
  }

  // 允许环境变量覆盖预设值
  return {
    label: preset.label,
    embeddingUrl: process.env.EMBEDDING_API_URL || preset.embeddingUrl,
    embeddingModel: process.env.EMBEDDING_MODEL || preset.embeddingModel,
    chatUrl: process.env.LLM_API_URL || preset.chatUrl,
    chatModel: process.env.LLM_MODEL || preset.chatModel,
  }
}

export function listPresets(): Array<{ key: string; label: string }> {
  return Object.entries(presets)
    .filter(([k]) => k !== 'custom')
    .map(([key, p]) => ({ key, label: p.label }))
}
