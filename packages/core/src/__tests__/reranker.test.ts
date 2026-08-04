import { describe, test, expect } from 'bun:test'
import { createJinaReranker, createReranker, createTeiReranker, type RerankInput } from '../reranker'

function mockJson(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
}

function mockStatus(status: number, text = 'error'): typeof fetch {
  return (async () => new Response(text, { status })) as unknown as typeof fetch
}

describe('TEI Reranker', () => {
  test('空 texts 短路返回 []', async () => {
    const r = createTeiReranker('http://x', 'm')
    const out = await r.rerank({ query: 'q', texts: [] })
    expect(out).toEqual([])
  })

  test('成功解析响应并按 index/score 映射', async () => {
    const fetchImpl = mockJson(200, [
      { index: 0, score: 0.9 },
      { index: 1, score: 0.1 },
      { index: 2, score: 0.5 },
    ])
    const r = createTeiReranker('http://tei.local', 'bge-reranker', fetchImpl, 5_000)
    const out = await r.rerank({ query: 'q', texts: ['a', 'b', 'c'] })
    expect(out.length).toBe(3)
    expect(out[0]).toEqual({ index: 0, score: 0.9 })
    expect(out[2]!.score).toBe(0.5)
  })

  test('topN 透传', async () => {
    let captured: unknown = null
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(init!.body as string)
      return new Response(JSON.stringify([{ index: 0, score: 1 }]), { status: 200 })
    }) as unknown as typeof fetch
    const r = createTeiReranker('http://x', 'm', fetchImpl, 5_000)
    await r.rerank({ query: 'q', texts: ['a', 'b', 'c'], topN: 2 })
    expect((captured as RerankInput).topN).toBeUndefined() // topN 不在 body 里
    expect((captured as { top_n?: number }).top_n).toBe(2)
  })

  test('失败抛错且可读错误体', async () => {
    const fetchImpl = mockStatus(503, 'service unavailable')
    const r = createTeiReranker('http://x', 'm', fetchImpl, 5_000)
    await expect(r.rerank({ query: 'q', texts: ['a'] })).rejects.toThrow(/503/)
  })

  test('带 apiKey 时写入 Bearer', async () => {
    let capturedHeaders: Record<string, string> = {}
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init!.headers as Record<string, string>
      return new Response(JSON.stringify([{ index: 0, score: 1 }]), { status: 200 })
    }) as unknown as typeof fetch
    const r = createTeiReranker('http://x', 'm', fetchImpl, 5_000, 'secret-key')
    await r.rerank({ query: 'q', texts: ['a'] })
    expect(capturedHeaders['Authorization']).toBe('Bearer secret-key')
  })
})

describe('Jina 风格 Reranker（SiliconFlow / Jina / Cohere / DashScope）', () => {
  test('请求体用 documents，响应解析 results[].relevance_score', async () => {
    let captured: Record<string, unknown> = {}
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(init!.body as string)
      return new Response(JSON.stringify({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.3 },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    const r = createJinaReranker('https://api.siliconflow.cn/v1', 'BAAI/bge-reranker-v2-m3', fetchImpl, 5_000, 'k')
    const out = await r.rerank({ query: 'q', texts: ['a', 'b'], topN: 2 })
    expect(captured.documents).toEqual(['a', 'b'])
    expect(captured.texts).toBeUndefined()
    expect(captured.model).toBe('BAAI/bge-reranker-v2-m3')
    expect(captured.top_n).toBe(2)
    expect(out).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.3 },
    ])
  })

  test('空 texts 短路返回 []', async () => {
    const r = createJinaReranker('http://x', 'm')
    expect(await r.rerank({ query: 'q', texts: [] })).toEqual([])
  })

  test('失败抛错且可读错误体', async () => {
    const fetchImpl = mockJson(400, { code: 20015, message: 'Field required' })
    const r = createJinaReranker('http://x', 'm', fetchImpl, 5_000)
    await expect(r.rerank({ query: 'q', texts: ['a'] })).rejects.toThrow(/400/)
  })
})

describe('createReranker 按 baseUrl 分派', () => {
  test('siliconflow / jina / cohere 走 Jina 协议', () => {
    expect(createReranker('https://api.siliconflow.cn/v1', 'm').name).toBe('jina-rerank-m')
    expect(createReranker('https://api.jina.ai/v1', 'm').name).toBe('jina-rerank-m')
    expect(createReranker('https://api.cohere.ai/v1', 'm').name).toBe('jina-rerank-m')
  })

  test('DashScope（aliyuncs.com）走 Jina 风格协议但路径为 /reranks', async () => {
    let capturedUrl = ''
    let captured: Record<string, unknown> = {}
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input)
      captured = JSON.parse(init!.body as string)
      return new Response(JSON.stringify({
        results: [{ index: 0, relevance_score: 0.9 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    const r = createReranker('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3-rerank', fetchImpl, 5_000, 'k')
    expect(r.name).toBe('jina-rerank-qwen3-rerank')
    const out = await r.rerank({ query: 'q', texts: ['a', 'b'], topN: 1 })
    expect(capturedUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/reranks')
    expect(captured.documents).toEqual(['a', 'b'])
    expect(captured.model).toBe('qwen3-rerank')
    expect(out).toEqual([{ index: 0, score: 0.9 }])
    // workspace 级域名同样命中
    expect(createReranker('https://ws123.cn-beijing.maas.aliyuncs.com/compatible-api/v1', 'm').name).toBe('jina-rerank-m')
  })

  test('自托管 / 未知域名保持 TEI 协议', () => {
    expect(createReranker('http://tei.local:8080', 'm').name).toBe('tei-rerank-m')
    expect(createReranker('https://example.com/v1', 'm').name).toBe('tei-rerank-m')
  })
})
