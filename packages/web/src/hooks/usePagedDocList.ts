/**
 * 文档列表分页：GET /docs/list?limit= + X-Next-Cursor。
 * 筛选条件变化或 SSE 刷新时回到第一页；加载更多只追加。
 * 同一路径有缓存时先画出旧数据再后台刷新，避免骨架屏把「已看过的列表」闪没。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocSummary } from '@notefast/core'
import { getJsonWithCursor } from './useAPI'

export const DOC_LIST_PAGE_SIZE = 80

const PAGE_CACHE_MAX = 8
const pageCache = new Map<string, { docs: DocSummary[]; nextCursor: string | null }>()

function readPageCache(path: string): { docs: DocSummary[]; nextCursor: string | null } | null {
  const hit = pageCache.get(path)
  if (!hit) return null
  pageCache.delete(path)
  pageCache.set(path, hit)
  return hit
}

function writePageCache(path: string, docs: DocSummary[], nextCursor: string | null): void {
  pageCache.delete(path)
  pageCache.set(path, { docs, nextCursor })
  while (pageCache.size > PAGE_CACHE_MAX) {
    const oldest = pageCache.keys().next().value
    if (oldest == null) break
    pageCache.delete(oldest)
  }
}

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
  const [docs, setDocs] = useState<DocSummary[]>(() => readPageCache(listPath)?.docs ?? [])
  const [nextCursor, setNextCursor] = useState<string | null>(() => readPageCache(listPath)?.nextCursor ?? null)
  const [loading, setLoading] = useState(() => !readPageCache(listPath))
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
    const hit = readPageCache(listPath)
    if (hit) {
      setDocs(hit.docs)
      setNextCursor(hit.nextCursor)
      setLoading(false)
    } else {
      setDocs([])
      setNextCursor(null)
      setLoading(true)
    }
    setError(null)
    getJsonWithCursor<DocSummary[]>(withLimit(listPath, null))
      .then(({ data, nextCursor: next }) => {
        writePageCache(listPath, data, next)
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
          const merged = [...prev, ...data.filter((d) => !seen.has(d.id))]
          writePageCache(listPathRef.current, merged, next)
          return merged
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
