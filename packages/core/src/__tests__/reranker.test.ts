import { describe, test, expect } from 'bun:test'
import { createTeiReranker, type RerankInput } from '../reranker'

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
