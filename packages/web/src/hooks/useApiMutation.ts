/**
 * useApiMutation — 写操作 hook
 *
 * 与 useApiQuery 的对照：
 *  - 没有 deps / 自动触发；mutate(args) 显式触发
 *  - 返回 { mutate, loading, error, data, reset }
 *  - **仅 network error 重试**（fetch 抛 TypeError / AbortError 等），
 *    4xx / 5xx 立即返回（ApiError 由 server 端契约定义，重试也救不了）
 *  - POST 默认不重试（可能产生重复资源）；PUT/PATCH/DELETE 默认重试
 *    （幂等）。要覆盖传 `retry: { enabled: true|false }`。
 *
 * 用法（最常见）：编辑器保存、文档状态切换、tag 增删
 *
 * ```ts
 * const saveDoc = useApiMutation<{ docId: string; markdown: string }, { ok: boolean }>({
 *   method: 'put',
 *   path: '/docs/:docId/markdown',
 *   onSuccess: () => toast.success(...),
 * })
 *
 * <button onClick={() => saveDoc.mutate({ docId, markdown })}>
 *   {saveDoc.loading ? '保存中…' : '保存'}
 * </button>
 * ```
 *
 * 注：62 处直接调 `api.xxx()` 的存量代码保留，向 useApiMutation 迁移是
 * 渐进式（哪个 loading/error UX 想要就改哪个）。本 hook 不强制全局切换。
 */

import { useCallback, useState } from 'react'
import { api, ApiError } from './useAPI'

type Method = 'post' | 'put' | 'patch' | 'del'

interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** 覆盖默认（POST 默认 false，其他默认 true） */
  enabled?: boolean
}

interface UseApiMutationOptions<TIn, TOut> {
  method: Method
  /**
   * 路径模板，支持 `:name` 占位符从 TIn 里取同名字段并 encodeURIComponent。
   * 也可传纯字符串（无占位符）或直接传静态 path。
   */
  path: string | ((vars: TIn) => string)
  onSuccess?: (data: TOut, variables: TIn) => void
  onError?: (error: unknown, variables: TIn) => void
  retry?: RetryOptions
}

interface UseApiMutationResult<TIn, TOut> {
  /** 触发一次；返回 TOut，失败时返回 undefined 并写入 error */
  mutate: (variables: TIn) => Promise<TOut | undefined>
  loading: boolean
  error: Error | null
  data: TOut | null
  reset: () => void
}

function interpolate(path: string, vars: Record<string, unknown>): string {
  return path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, key: string) => {
    const v = vars[key]
    return encodeURIComponent(v === undefined || v === null ? '' : String(v))
  })
}

/**
 * 重试决策 + 退避延迟（导出用于纯函数测试）。
 *
 * 规则：
 *  - ApiError（4xx/5xx）：立即 stop retry——服务端契约性问题，重试无意义
 *  - network error（其它）：retry until attempts exhausted
 *  - 退避：base * 2^attempt，上限 maxDelayMs，加 0–25% 随机抖动错峰
 */
export interface RetryDecision {
  shouldRetry: boolean
  /** 重试前的退避延迟（最后一次不再设） */
  delayMs?: number
}

export function nextRetryDecision(
  err: unknown,
  attempt: number,
  attempts: number,
  baseMs: number,
  maxMs: number,
): RetryDecision {
  if (err instanceof ApiError) return { shouldRetry: false }
  if (attempt >= attempts - 1) return { shouldRetry: false }
  const base = Math.min(baseMs * 2 ** attempt, maxMs)
  const jitter = Math.floor(Math.random() * base * 0.25)
  return { shouldRetry: true, delayMs: base + jitter }
}

export function useApiMutation<TIn = void, TOut = unknown>(
  options: UseApiMutationOptions<TIn, TOut>,
): UseApiMutationResult<TIn, TOut> {
  const { method, path, onSuccess, onError, retry } = options
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [data, setData] = useState<TOut | null>(null)

  const retryEnabled = retry?.enabled ?? method !== 'post'
  const retryAttempts = Math.max(1, retry?.attempts ?? 3)
  const retryBase = retry?.baseDelayMs ?? 400
  const retryMax = retry?.maxDelayMs ?? 5_000

  const mutate = useCallback(
    async (variables: TIn): Promise<TOut | undefined> => {
      setLoading(true)
      setError(null)
      setData(null)

      const varsObj = (variables ?? {}) as Record<string, unknown>
      const resolvedPath =
        typeof path === 'function' ? path(variables as TIn) : interpolate(path, varsObj)

      const call = (): Promise<TOut> =>
        method === 'del'
          ? api.del<TOut>(resolvedPath)
          : (api[method]<TOut>(resolvedPath, variables as unknown) as Promise<TOut>)

      const totalAttempts = retryEnabled ? retryAttempts : 1
      let lastErr: unknown = null
      for (let attempt = 0; attempt < totalAttempts; attempt++) {
        try {
          const result = await call()
          setData(result)
          setLoading(false)
          onSuccess?.(result, variables)
          return result
        } catch (err) {
          lastErr = err
          const decision = nextRetryDecision(err, attempt, totalAttempts, retryBase, retryMax)
          if (!decision.shouldRetry) break
          await new Promise((r) => setTimeout(r, decision.delayMs ?? 0))
        }
      }

      const wrapped =
        lastErr instanceof Error ? lastErr : new Error(`mutation failed: ${String(lastErr)}`)
      setError(wrapped)
      setLoading(false)
      onError?.(lastErr, variables)
      return undefined
    },
    [method, path, onSuccess, onError, retryEnabled, retryAttempts, retryBase, retryMax],
  )

  const reset = useCallback(() => {
    setLoading(false)
    setError(null)
    setData(null)
  }, [])

  return { mutate, loading, error, data, reset }
}