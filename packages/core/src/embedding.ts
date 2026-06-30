/**
 * Embedding Provider 接口
 *
 * 设计原则：
 * - 可插拔：本地 Ollama / 云端 OpenAI / transformers.js 实现同一接口
 * - 向量维度由 Provider 决定，存储时保存
 * - embedBatch 批量内嵌（用于建索引），embedQuery 单条（用于搜索）
 */

export interface EmbeddingProvider {
  readonly name: string

  /** 默认批量大小 */
  readonly batchSize: number

  /** 一次请求的最大 tokens（用于截断） */
  readonly maxTokens: number

  /** 生成多条文本的向量 */
  embedBatch(texts: string[]): Promise<Array<Float64Array>>

  /** 生成单条查询文本的向量 */
  embedQuery(text: string): Promise<Float64Array>
}

/** Provider 工厂签名 */
export type EmbeddingProviderFactory = (config: Record<string, string>) => EmbeddingProvider

/** 向量存储行 */
export interface VectorRow {
  block_id: string
  embedding: string // JSON 序列化的 f64[]
  dim: number
}

/** 语义搜索结果 */
export interface SemanticHit {
  block_id: string
  score: number // 余弦相似度，越接近 1 越相关
  content: string
  doc_id: string
  doc_title: string
}

/** 计算两个向量的余弦相似度 */
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

/** 裁剪文本到指定 token 数（粗略估算：中文字按字，英文按空格分词） */
export function truncateText(text: string, maxTokens: number): string {
  const tokens = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=\S)\s(?=\S)/)
  if (tokens.length <= maxTokens) return text
  return tokens.slice(0, maxTokens).join(' ')
}
