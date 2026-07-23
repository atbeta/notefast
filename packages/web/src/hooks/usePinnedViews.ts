import { useState, useEffect, useCallback } from 'react'
import { api } from './useAPI'

const MAX_VIEWS = 50

export interface PinnedView {
  id: string
  name: string
  query: string
  createdAt: string
}

export function usePinnedViews() {
  const [views, setViews] = useState<PinnedView[]>([])

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<PinnedView[]>('/pinned-views')
      if ('body' in res && Array.isArray(res.body)) setViews(res.body)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const pin = useCallback(async (name: string, query: string) => {
    if (views.length >= MAX_VIEWS) return false
    try {
      await api.post('/pinned-views', { name: name.trim().slice(0, 50), query })
      await refresh()
      return true
    } catch {
      return false
    }
  }, [views.length, refresh])

  const unpin = useCallback(async (id: string) => {
    try {
      await api.del(`/pinned-views/${id}`)
      refresh()
    } catch { /* ignore */ }
  }, [refresh])

  const isPinned = useCallback((query: string): boolean => {
    return views.some((v) => v.query === query)
  }, [views])

  return { views, pin, unpin, isPinned }
}
