import { afterEach, describe, expect, test } from 'bun:test'
import { streamSSE, type SSEError } from '../streaming'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetchOnce(res: Response | (() => Promise<Response>)) {
  globalThis.fetch = (typeof res === 'function'
    ? res
    : () => Promise.resolve(res)) as unknown as typeof fetch
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

interface RunResult {
  events: Array<[string, unknown]>
  error: SSEError | null
  done: boolean
  aborted: boolean
}

/** 驱动一次 streamSSE，Promise 在 onError / onDone / onAbort 任一终结回调时落定 */
function run(): { result: Promise<RunResult>; ac: AbortController } {
  const events: Array<[string, unknown]> = []
  const out = { error: null as SSEError | null, done: false, aborted: false }
  let settle!: (r: RunResult) => void
  const result = new Promise<RunResult>((res) => {
    settle = res
  })
  const finish = () => settle({ events, ...out })
  const ac = streamSSE(
    '/ai/chat',
    { messages: [] },
    {
      onEvent: (name, data) => events.push([name, data]),
      onError: (err) => {
        out.error = err
        finish()
      },
      onDone: () => {
        out.done = true
        finish()
      },
      onAbort: () => {
        out.aborted = true
        finish()
      },
    },
  )
  return { result, ac }
}

describe('streamSSE', () => {
  test('token/done 序列：onEvent 按序分发，done 触发 onDone', async () => {
    mockFetchOnce(
      sseResponse(
        'event: ping\ndata: {}\n\n' +
          'event: token\ndata: {"content":"你"}\n\n' +
          'event: token\ndata: {"content":"好"}\n\n' +
          'event: done\ndata: {"citations":[]}\n\n',
      ),
    )
    const { result } = run()
    const r = await result
    expect(r.error).toBeNull()
    expect(r.done).toBe(true)
    expect(r.events.map(([name]) => name)).toEqual(['ping', 'token', 'token', 'done'])
    expect(r.events[1]![1]).toEqual({ content: '你' })
  })

  test('error 帧：抛错到 onError，message 与 code 透传，onDone 不触发', async () => {
    mockFetchOnce(
      sseResponse(
        'event: token\ndata: {"content":"半截"}\n\n' +
          'event: error\ndata: {"code":"not_configured","message":"AI chat 未配置"}\n\n',
      ),
    )
    const { result } = run()
    const r = await result
    expect(r.done).toBe(false)
    expect(r.events.map(([name]) => name)).toEqual(['token'])
    expect(r.error).not.toBeNull()
    expect(r.error!.message).toBe('AI chat 未配置')
    expect(r.error!.code).toBe('not_configured')
  })

  test('error 帧无 code/message：code 为 undefined，message 有兜底', async () => {
    mockFetchOnce(sseResponse('event: error\ndata: {}\n\n'))
    const { result } = run()
    const r = await result
    expect(r.error).not.toBeNull()
    expect(r.error!.message).toBe('SSE stream error')
    expect(r.error!.code).toBeUndefined()
  })

  test('坏帧 warn 丢弃，流继续（keep-alive / 心跳噪声不影响后续帧）', async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      mockFetchOnce(
        sseResponse(
          'event: token\ndata: {oops-not-json\n\n' +
            'event: token\ndata: {"content":"ok"}\n\n' +
            'event: done\ndata: {}\n\n',
        ),
      )
      const { result } = run()
      const r = await result
      expect(r.done).toBe(true)
      expect(r.events.map(([name]) => name)).toEqual(['token', 'done'])
      expect(r.events[0]![1]).toEqual({ content: 'ok' })
      expect(warns.length).toBe(1)
    } finally {
      console.warn = origWarn
    }
  })

  test('HTTP 非 2xx：onError 带 message 与 REST 错误码（body.error）', async () => {
    mockFetchOnce(
      new Response(JSON.stringify({ error: 'not_configured', message: 'AI chat 未配置' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const { result } = run()
    const r = await result
    expect(r.error!.message).toBe('AI chat 未配置')
    expect(r.error!.code).toBe('not_configured')
  })

  test('用户停止（abort）：走 onAbort，onError/onDone 均不触发', async () => {
    // 模拟 fetch 在 signal abort 时以 AbortError 拒绝
    globalThis.fetch = ((_url: string, opts?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const e = new Error('The operation was aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })) as unknown as typeof fetch

    const { result, ac } = run()
    ac.abort()
    const r = await result
    expect(r.aborted).toBe(true)
    expect(r.error).toBeNull()
    expect(r.done).toBe(false)
  })
})
