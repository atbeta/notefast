import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseApiQueryResult<T> {
  data: T | null
  loading: boolean
  error: Error | null
  /** 重新执行查询（loading 重新置 true；成功后清空 error，失败保留旧 data） */
  refetch: () => void
}

/**
 * GET 三段式（useState + useEffect + then/catch/finally）的收敛：
 * - deps 语义同 useEffect，变化即重新拉取；refetch() 手动重拉
 * - 组件卸载后不再 setState
 * - error 不吞：返回给调用方决定如何呈现（console / 静默 / 错误 UI）
 */
export function useApiQuery<T>(fn: () => Promise<T>, deps: readonly unknown[]): UseApiQueryResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)
  // fn 多为内联闭包、每次渲染都变；经 ref 取最新，避免把 fn 放进 deps 造成死循环
  const fnRef = useRef(fn)
  fnRef.current = fn

  const refetch = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fnRef.current()
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setError(null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // deps 由调用方显式给出（同 useEffect 语义）；tick 仅驱动 refetch
  }, [...deps, tick])

  return { data, loading, error, refetch }
}
