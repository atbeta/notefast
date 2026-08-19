/**
 * 文档列表分页：GET /docs/list?limit= + X-Next-Cursor。
 * 筛选条件变化或 SSE 刷新时回到第一页；加载更多只追加。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocSummary } from '@notefast/core'
import { getJsonWithCursor } from './useAPI'

export const DOC_LIST_PAGE_SIZE = 80

function withLimit(pathAndQuery: string, cursor: string | null): string {
  const qIndex = pathAndQuery.indexOf('?')
  const path = qIndex < 0 ? pathAndQuery : pathAndQuery.slice(0, qIndex)
  const params = new URLSearchParams(qIndex < 0 ? '' : pathAndQuery.slice(qIndex + 1))
  params.set('limit', String(DOC_LIST_PAGE_SIZE))
  if (cursor) params.set('cursor', cursor)
  else params.delete('cursor')
  const s = params.toString()
  return `${path}?${s}`
}

export function usePagedDocList(listPath: string): {
  docs: DocSummary[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  error: Error | null
  refetch: () => void
  loadMore: () => void
} {
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)
  const listPathRef = useRef(listPath)
  listPathRef.current = listPath
  const nextRef = useRef<string | null>(null)
  nextRef.current = nextCursor

  const refetch = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getJsonWithCursor<DocSummary[]>(withLimit(listPath, null))
      .then(({ data, nextCursor: next }) => {
        if (cancelled) return
        setDocs(data)
        setNextCursor(next)
        setError(null)
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
  }, [listPath, tick])

  const loadMore = useCallback(() => {
    const cursor = nextRef.current
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    getJsonWithCursor<DocSummary[]>(withLimit(listPathRef.current, cursor))
      .then(({ data, nextCursor: next }) => {
        setDocs((prev) => {
          const seen = new Set(prev.map((d) => d.id))
          return [...prev, ...data.filter((d) => !seen.has(d.id))]
        })
        setNextCursor(next)
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }, [loadingMore])

  return {
    docs,
    loading,
    loadingMore,
    hasMore: Boolean(nextCursor),
    error,
    refetch,
    loadMore,
  }
}
