import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseApiQueryResult<T> {
  data: T | null
  /**
   * 仅首次加载（还没有任何数据）为 true。
   * 后续 refetch / deps 变化走 stale-while-revalidate：保留旧数据渲染，
   * 不再触发骨架屏（视图切换、MCP 写入后的自动刷新都不闪）。
   */
  loading: boolean
  error: Error | null
  /** 重新执行查询（有旧数据时 loading 保持 false；成功后清空 error，失败保留旧 data） */
  refetch: () => void
}

/**
 * GET 三段式（useState + useEffect + then/catch/finally）的收敛：
 * - deps 语义同 useEffect，变化即重新拉取；refetch() 手动重拉
 * - stale-while-revalidate：loading 仅表示「无数据可显示的首次加载」，
 *   重新拉取期间旧数据继续渲染，避免骨架屏闪现再消失
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
  // data 进 ref：effect 内判断是否首载，不把 data 放进 deps
  const dataRef = useRef<T | null>(null)
  dataRef.current = data

  const refetch = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let cancelled = false
    // stale-while-revalidate：已有数据时保留旧数据渲染，不重置 loading
    if (dataRef.current === null) setLoading(true)
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
