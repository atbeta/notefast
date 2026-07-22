/**
 * Embedding Provider 接口 + 工具函数
 *
 * runtime.ts 提供 OpenAI 兼容实现，此处只保留接口契约和数学工具。
 */

export interface EmbeddingProvider {
  readonly name: string
  readonly batchSize: number
  readonly maxTokens: number
  embedBatch(texts: string[]): Promise<Array<Float64Array>>
  embedQuery(text: string): Promise<Float64Array>
}

export interface VectorRow {
  block_id: string
  embedding: string // JSON 序列化的 f64[]
  dim: number
}

export interface SemanticHit {
  block_id: string
  score: number
  content: string
  doc_id: string
  doc_title: string
}

/** 余弦相似度 */
export function cosineSimilarity(a: Float64Array | number[], b: Float64Array | number[]): number {
  const aArr = Array.isArray(a) ? a : Array.from(a)
  const bArr = Array.isArray(b) ? b : Array.from(b)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < aArr.length; i++) {
    dot += aArr[i] * bArr[i]
    normA += aArr[i] * aArr[i]
    normB += bArr[i] * bArr[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * 粗略 token 截断：
 * - 英文按空白分词，超限时按词截断（不切断单词）；
 * - 中文等无空格文本按空白分词恒为 1 个 token，按词数永不超限，
 *   此时退化为按字符截断（CJK 场景一个字符近似一个 token）。
 */
export function truncateText(text: string, maxTokens: number): string {
  const tokens = text.replace(/\s+/g, ' ').trim().split(/(?<=\S)\s(?=\S)/)
  if (tokens.length > maxTokens) return tokens.slice(0, maxTokens).join(' ')
  // 按词数未超限：若存在长度超过 maxTokens 的单个“词”（典型为无空格的中文长文），
  // 截断到该词的前 maxTokens 个字符
  const longWord = tokens.find((t) => t.length > maxTokens)
  if (!longWord) return text
  return text.slice(0, text.indexOf(longWord) + maxTokens)
}