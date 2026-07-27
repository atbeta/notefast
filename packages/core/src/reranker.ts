/**
 * Reranker Provider 接口 + 两种协议实现
 *
 * Reranker 是与 embedding 独立的能力——交叉注意力精排，
 * 对 hybrid search 召回后的 top-K 做二次排序。
 *
 * 两种线协议：
 * - TEI（默认，自托管）：body { query, texts } → resp [{ index, score }]
 * - Jina 风格（SiliconFlow / Jina / Cohere）：body { model, query, documents }
 *   → resp { results: [{ index, relevance_score }] }
 * createReranker 按 baseUrl 域名自动分派；baseUrl 都只给到 /v1，/rerank 由实现拼接。
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

/**
 * Jina 风格 /rerank 实现（SiliconFlow / Jina / Cohere 同协议）：
 *   POST {baseUrl}/rerank
 *   body: { model, query, documents: string[], top_n?, return_documents?: boolean }
 *   resp: { results: Array<{ index, relevance_score }> }
 * 与 TEI 的差异仅在字段名（documents / relevance_score / 外层 results 包装）。
 */
export function createJinaReranker(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 30_000,
  apiKey = '',
): RerankerProvider {
  const url = joinUrl(baseUrl, '/rerank')
  const headers = buildHeaders(apiKey)

  return {
    name: `jina-rerank-${model}`,
    async rerank({ query, texts, topN }): Promise<RerankHit[]> {
      if (texts.length === 0) return []
      const json = await postJson<{ results?: Array<{ index: number; relevance_score: number }> }>(
        fetchImpl,
        url,
        headers,
        {
          model,
          query,
          documents: texts,
          top_n: topN ?? texts.length,
          return_documents: false,
        },
        { timeoutMs, errorLabel: 'Rerank API' },
      )
      return (json.results ?? []).map((r) => ({ index: r.index, score: r.relevance_score }))
    },
  }
}

/** Jina 风格协议的已知服务商域名（这些平台的 /rerank 不是 TEI 协议） */
const JINA_STYLE_HOSTS = /(^|\.)(siliconflow\.cn|jina\.ai|cohere\.(ai|com))$/i

/**
 * 按 baseUrl 分派 reranker 实现：已知 Jina 协议平台走 createJinaReranker，
 * 其余（自托管 TEI 等）保持 TEI 默认。baseUrl 只需给到 /v1，/rerank 由实现拼接。
 */
export function createReranker(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 30_000,
  apiKey = '',
): RerankerProvider {
  let host = ''
  try {
    host = new URL(baseUrl).hostname
  } catch { /* 非法 URL 时按 TEI 处理，请求阶段会以可读错误暴露 */ }
  if (JINA_STYLE_HOSTS.test(host)) return createJinaReranker(baseUrl, model, fetchImpl, timeoutMs, apiKey)
  return createTeiReranker(baseUrl, model, fetchImpl, timeoutMs, apiKey)
}
