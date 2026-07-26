import { useState, useRef, useCallback, useMemo } from 'react'
import { streamSSE } from '../lib/streaming'
import type { WriteMode } from '@notefast/core'

interface StreamCallbacks {
  onToken: (text: string) => void
}

interface UseAiWritingResult {
  isStreaming: boolean
  error: string | null
  streamContinue: (content: string, cbs: StreamCallbacks) => Promise<string>
  streamRefine: (content: string, instruction: string, cbs: StreamCallbacks) => Promise<string>
  cancel: () => void
}

export function useAiWriting(): UseAiWritingResult {
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const stream = useCallback(
    async (
      mode: WriteMode,
      content: string,
      cbs: StreamCallbacks,
      opts?: { instruction?: string },
    ): Promise<string> => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      return new Promise<string>((resolve, reject) => {
        let result = ''

        const ac = streamSSE(
          '/ai/write',
          {
            mode,
            content,
            ...(opts?.instruction ? { instruction: opts.instruction } : {}),
            max_tokens: 1024,
          },
          {
            onEvent: (eventName, data) => {
              const payload = data as { content?: string }
              if (eventName === 'token' && payload.content) {
                result += payload.content
                setIsStreaming(true)
                cbs.onToken(payload.content)
              } else if (eventName === 'done') {
                setIsStreaming(false)
                setError(null)
                abortRef.current = null
                resolve(result)
              } else if (eventName === 'error') {
                const err = data as { message?: string }
                setIsStreaming(false)
                setError(err.message || 'AI 写作失败')
                abortRef.current = null
                reject(new Error(err.message || 'AI 写作失败'))
              }
            },
            onError: (err) => {
              setIsStreaming(false)
              setError(err.message)
              abortRef.current = null
              reject(err)
            },
            onDone: () => {
              setIsStreaming(false)
              setError(null)
              abortRef.current = null
              resolve(result)
            },
          },
          controller.signal,
        )

        abortRef.current = ac
      })
    },
    [],
  )

  const streamContinue = useCallback(
    (content: string, cbs: StreamCallbacks) => stream('continue', content, cbs),
    [stream],
  )

  const streamRefine = useCallback(
    (content: string, instruction: string, cbs: StreamCallbacks) =>
      stream('refine', content, cbs, { instruction }),
    [stream],
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsStreaming(false)
  }, [])

  return useMemo(
    () => ({
      isStreaming,
      error,
      streamContinue,
      streamRefine,
      cancel,
    }),
    [isStreaming, error, streamContinue, streamRefine, cancel],
  )
}
