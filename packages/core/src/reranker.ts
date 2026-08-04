/**
 * Reranker Provider 接口 + 两种协议实现
 *
 * Reranker 是与 embedding 独立的能力——交叉注意力精排，
 * 对 hybrid search 召回后的 top-K 做二次排序。
 *
 * 两种线协议：
 * - TEI（默认，自托管）：body { query, texts } → resp [{ index, score }]
 * - Jina 风格（SiliconFlow / Jina / Cohere / DashScope）：body { model, query, documents }
 *   → resp { results: [{ index, relevance_score }] }
 * createReranker 按 baseUrl 域名自动分派；baseUrl 都只给到 /v1，/rerank(s) 由实现拼接
 * （DashScope qwen3-rerank 是 /reranks 复数路径，其余为 /rerank）。
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
 * Jina 风格 /rerank 实现（SiliconFlow / Jina / Cohere / DashScope 同协议）：
 *   POST {baseUrl}{path}
 *   body: { model, query, documents: string[], top_n?, return_documents?: boolean }
 *   resp: { results: Array<{ index, relevance_score }> }
 * 与 TEI 的差异仅在字段名（documents / relevance_score / 外层 results 包装）。
 * path 默认 /rerank；DashScope qwen3-rerank 的 OpenAI 兼容端点是 /reranks（复数），
 * 协议字段与响应形状和 Jina 完全一致（gte-rerank-v2 的旧嵌套协议已于 2026-05-30 下线，不支持）。
 */
export function createJinaReranker(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 30_000,
  apiKey = '',
  path: '/rerank' | '/reranks' = '/rerank',
): RerankerProvider {
  const url = joinUrl(baseUrl, path)
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
 * 阿里云百炼（DashScope）：qwen3-rerank 走 OpenAI 兼容端点 {base}/reranks（复数），
 * body/响应与 Jina 风格一致。匹配整个 aliyuncs.com 域（dashscope.* 与 workspace 级 maas.* 都覆盖）。
 *
 * 端点注意：百炼的 rerank 兼容端点是 compatible-api（chat/embeddings 的 compatible-mode
 * 不含 /reranks，2026 起调用即 404）——分派时把 baseUrl 的 compatible-mode 段替换掉；
 * workspace 级 maas.* 端点（compatible-api 已在 baseUrl 中）不受影响。
 */
const DASHSCOPE_HOSTS = /(^|\.)aliyuncs\.com$/i

/**
 * 按 baseUrl 分派 reranker 实现：已知 Jina 协议平台走 createJinaReranker，
 * 其余（自托管 TEI 等）保持 TEI 默认。baseUrl 只需给到 /v1，/rerank(s) 由实现拼接。
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
  if (DASHSCOPE_HOSTS.test(host)) {
    const rerankBase = baseUrl.replace(/\/compatible-mode\/v1\/?$/, '/compatible-api/v1')
    return createJinaReranker(rerankBase, model, fetchImpl, timeoutMs, apiKey, '/reranks')
  }
  if (JINA_STYLE_HOSTS.test(host)) return createJinaReranker(baseUrl, model, fetchImpl, timeoutMs, apiKey)
  return createTeiReranker(baseUrl, model, fetchImpl, timeoutMs, apiKey)
}
