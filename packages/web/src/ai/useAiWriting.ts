import { useState, useRef, useCallback, useMemo } from 'react'
import i18next from '../i18n'
import { streamSSE } from '../lib/streaming'
import type { WriteMode } from '@notefast/core'

interface StreamCallbacks {
  onToken: (text: string) => void
}

interface StreamContinueOpts {
  /** 光标后正文，避免续写与后文重复 */
  suffix?: string
}

interface StreamRefineOpts {
  /** 选区前 / 后，避免改写与前后文脱节 */
  prefix?: string
  suffix?: string
}

interface UseAiWritingResult {
  isStreaming: boolean
  error: string | null
  streamContinue: (content: string, cbs: StreamCallbacks, opts?: StreamContinueOpts) => Promise<string>
  streamRefine: (content: string, instruction: string, cbs: StreamCallbacks, opts?: StreamRefineOpts) => Promise<string>
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
      opts?: { instruction?: string; prefix?: string; suffix?: string; maxTokens?: number },
    ): Promise<string> => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setIsStreaming(true)
      setError(null)

      return new Promise<string>((resolve, reject) => {
        let result = ''

        const ac = streamSSE(
          '/ai/write',
          {
            mode,
            content,
            ...(opts?.instruction ? { instruction: opts.instruction } : {}),
            ...(opts?.prefix ? { prefix: opts.prefix } : {}),
            ...(opts?.suffix ? { suffix: opts.suffix } : {}),
            max_tokens: opts?.maxTokens ?? 1024,
          },
          {
            onEvent: (eventName, data) => {
              const payload = data as { content?: string }
              if (eventName === 'token' && payload.content) {
                result += payload.content
                cbs.onToken(payload.content)
              } else if (eventName === 'done') {
                setIsStreaming(false)
                setError(null)
                abortRef.current = null
                resolve(result)
              } else if (eventName === 'error') {
                const err = data as { message?: string }
                setIsStreaming(false)
                setError(err.message || i18next.t('aiWrite.failed'))
                abortRef.current = null
                reject(new Error(err.message || i18next.t('aiWrite.failed')))
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
            onAbort: () => {
              setIsStreaming(false)
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
    (content: string, cbs: StreamCallbacks, opts?: StreamContinueOpts) =>
      stream('continue', content, cbs, { suffix: opts?.suffix, maxTokens: 384 }),
    [stream],
  )

  const streamRefine = useCallback(
    (content: string, instruction: string, cbs: StreamCallbacks, opts?: StreamRefineOpts) =>
      stream('refine', content, cbs, {
        instruction,
        prefix: opts?.prefix,
        suffix: opts?.suffix,
      }),
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
