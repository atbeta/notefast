import type { LLMProvider, ChatMessage, ChatCompletionOptions } from '@notefast/core'

/**
 * OpenAI 兼容的 Chat Completion Provider
 *
 * 配置：
 *   LLM_API_URL=https://api.openai.com/v1/chat/completions
 *   LLM_API_KEY=sk-...（未设则回退到 EMBEDDING_API_KEY）
 *   LLM_MODEL=gpt-4o-mini（默认）
 *
 * 兼容：DeepSeek / 智谱 / 百川 / Ollama 等 OpenAI 格式 API
 */

export function createOpenAILLM(config: Record<string, string>): LLMProvider {
  const apiUrl = config.LLM_API_URL || 'https://api.openai.com/v1/chat/completions'
  const apiKey = config.LLM_API_KEY || config.EMBEDDING_API_KEY || ''
  const model = config.LLM_MODEL || 'gpt-4o-mini'

  return {
    name: 'openai-chat-' + model,

    async chat(messages: ChatMessage[], options?: ChatCompletionOptions): Promise<string> {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: options?.model || model,
          messages,
          temperature: options?.temperature ?? 0.3,
          max_tokens: options?.maxTokens ?? 200,
        }),
      })

      if (!res.ok) {
        const err = await res.text().catch(() => '')
        throw new Error(`LLM API error ${res.status}: ${err.slice(0, 200)}`)
      }

      const json = (await res.json()) as {
        choices: Array<{ message: { content: string } }>
      }
      return json.choices?.[0]?.message?.content || ''
    },
  }
}
