import { fetchWithAuth } from '../hooks/useAPI'

export interface SSECallbacks {
  onEvent: (eventName: string, data: unknown) => void
  onError?: (err: Error) => void
  onDone?: () => void
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
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(err.message || `HTTP ${res.status}`)
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
              throw new Error(payload.message || 'SSE stream error')
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
      if ((err as { name?: string })?.name === 'AbortError') return
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
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
