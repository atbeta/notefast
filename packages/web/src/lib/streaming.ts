import { fetchWithAuth } from '../hooks/useAPI'

/**
 * 流式错误：HTTP 错误体的 error 字段（REST 稳定错误码，同 ApiError.code）或
 * 流内 error 帧 payload 的 code 会挂到 Error.code 上，供调用方稳定判别（如 not_configured）。
 */
export type SSEError = Error & { code?: string }

export interface SSECallbacks {
  onEvent: (eventName: string, data: unknown) => void
  onError?: (err: SSEError) => void
  onDone?: () => void
  /** 外部 signal 或返回的 controller 触发中断时调用（此时 onError/onDone 均不再触发） */
  onAbort?: () => void
}

export function streamSSE(
  path: string,
  body: unknown,
  callbacks: SSECallbacks,
  signal?: AbortSignal,
): AbortController {
  const ac = new AbortController()
  const combinedSignal = signal
    ? combineSignals(signal, ac.signal)
    : ac.signal

  void (async () => {
    try {
      const res = await fetchWithAuth(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: combinedSignal,
      })

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null
        const err = new Error(body?.message || `HTTP ${res.status}`) as SSEError
        if (typeof body?.error === 'string') err.code = body.error
        throw err
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let idx: number
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)

          let eventName = 'message'
          let data = ''
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
          }
          if (!data) continue

          try {
            const payload = JSON.parse(data)
            if (eventName === 'error') {
              const err = new Error(payload.message || 'SSE stream error') as SSEError
              if (typeof payload.code === 'string') err.code = payload.code
              throw err
            }
            callbacks.onEvent(eventName, payload)
            if (eventName === 'done') {
              callbacks.onDone?.()
              return
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && eventName !== 'error') {
              console.warn('[sse] drop unparseable frame:', parseErr.message)
            } else if (parseErr instanceof Error) {
              throw parseErr
            }
          }
        }
      }

      callbacks.onDone?.()
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        callbacks.onAbort?.()
        return
      }
      callbacks.onError?.(err instanceof Error ? (err as SSEError) : new Error(String(err)))
    }
  })()

  return ac
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted || b.aborted) return AbortSignal.abort()
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return ac.signal
}
