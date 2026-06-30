import type { EmbeddingProvider } from '@notefast/core'
import { truncateText } from '@notefast/core'

/**
 * OpenAI 兼容的 Embedding Provider
 *
 * 配置：
 *   EMBEDDING_API_URL=https://api.openai.com/v1/embeddings
 *   EMBEDDING_API_KEY=sk-...
 *   EMBEDDING_MODEL=text-embedding-3-small  (默认)
 *
 * 也兼容：
 *   - Anthropic（通过兼容代理）
 *   - 国内 API（智谱/百川 等兼容 OpenAI 格式的服务）
 *   - Ollama（http://localhost:11434/v1/embeddings，model 设置为你的模型名）
 */

export function createOpenAIProvider(config: Record<string, string>): EmbeddingProvider {
  const apiUrl = config.EMBEDDING_API_URL || 'https://api.openai.com/v1/embeddings'
  const apiKey = config.EMBEDDING_API_KEY || ''
  const model = config.EMBEDDING_MODEL || 'text-embedding-3-small'
  const batchSize = parseInt(config.EMBEDDING_BATCH_SIZE || '20', 10)
  const maxTokens = 8191

  return {
    name: 'openai-' + model,
    batchSize,
    maxTokens,

    async embedBatch(texts: string[]): Promise<Array<Float64Array>> {
      const truncated = texts.map((t) => truncateText(t, maxTokens))
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input: truncated }),
      })

      if (!res.ok) {
        const err = await res.text().catch(() => '')
        throw new Error(`Embedding API error ${res.status}: ${err.slice(0, 200)}`)
      }

      const json = (await res.json()) as { data: Array<{ embedding: number[] }> }
      return json.data.map((item) => new Float64Array(item.embedding))
    },

    async embedQuery(text: string): Promise<Float64Array> {
      const results = await this.embedBatch([text])
      return results[0]
    },
  }
}
