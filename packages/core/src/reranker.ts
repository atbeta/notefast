/**
 * Reranker Provider 接口 + TEI (Text Embeddings Inference) 实现
 *
 * Reranker 是与 embedding 独立的能力——交叉注意力精排，
 * 对 hybrid search 召回后的 top-K 做二次排序。
 *
 * 默认实现兼容 HuggingFace TEI 的 /rerank 端点：
 *   POST {baseUrl}/rerank
 *   body: { query, texts: string[], top_n?: number, return_documents?: boolean }
 *   resp: Array<{ index, score } | { index, score, document }>
 *
 * 也可自定义实现 RerankerProvider（无第三方服务时返回 undefined 即可降级）。
 */

import { buildHeaders, joinUrl, postJson } from './ai/openaiCompat'

export interface RerankInput {
  /** 用户的当前查询 */
  query: string
  /** 候选文档片段（block 文本），按当前顺序传入 */
  texts: string[]
  /** 最多返回多少条（不传则全量） */
  topN?: number
}

export interface RerankHit {
  /** 在输入 texts 中的下标 */
  index: number
  /** Reranker 打分（越大越相关） */
  score: number
}

export interface RerankerProvider {
  readonly name: string
  rerank(input: RerankInput): Promise<RerankHit[]>
}

/** TEI /rerank 端点的标准实现 */
export function createTeiReranker(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 30_000,
  apiKey = '',
): RerankerProvider {
  const url = joinUrl(baseUrl, '/rerank')
  const headers = buildHeaders(apiKey)

  return {
    name: `tei-rerank-${model}`,
    async rerank({ query, texts, topN }): Promise<RerankHit[]> {
      if (texts.length === 0) return []
      const json = await postJson<Array<{ index: number; score: number }>>(
        fetchImpl,
        url,
        headers,
        {
          query,
          texts,
          top_n: topN ?? texts.length,
          return_documents: false,
          model,
        },
        { timeoutMs, errorLabel: 'Rerank API' },
      )
      return json.map((r) => ({ index: r.index, score: r.score }))
    },
  }
}
