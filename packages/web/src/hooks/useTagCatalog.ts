/**
 * 标签云：会话缓存 + stale-while-revalidate。
 * 首次无缓存时 loading=true；之后先画旧 chip，后台刷新 count。
 */

import { useCallback, useEffect, useState } from 'react'
import type { TagInfo } from '@notefast/core'
import { api } from './useAPI'
import {
  loadTagCatalog,
  peekTagCatalog,
  subscribeTagCatalog,
  type TagCatalogPayload,
} from '../lib/tagCatalog'

function fetchCatalog(): Promise<TagCatalogPayload> {
  return api.get<TagCatalogPayload>('/tags')
}

/** 进壳即预取，从文档页回到「所有文档」时 chip 行已经在。 */
export function prefetchTagCatalog(): void {
  void loadTagCatalog(fetchCatalog)
}

export function useTagCatalog(): {
  tags: TagInfo[]
  loading: boolean
  error: Error | null
  refetch: () => void
} {
  const [data, setData] = useState(peekTagCatalog)
  const [loading, setLoading] = useState(() => peekTagCatalog() === null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => subscribeTagCatalog(() => {
    setData(peekTagCatalog())
    setLoading(false)
  }), [])

  useEffect(() => {
    let cancelled = false
    if (peekTagCatalog() === null) setLoading(true)
    loadTagCatalog(fetchCatalog)
      .then(() => {
        if (!cancelled) setError(null)
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
  }, [])

  const refetch = useCallback(() => {
    void loadTagCatalog(fetchCatalog)
  }, [])

  return {
    tags: data?.tags ?? [],
    loading,
    error,
    refetch,
  }
}
