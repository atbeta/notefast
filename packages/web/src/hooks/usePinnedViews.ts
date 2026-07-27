import { useState, useEffect, useCallback } from 'react'
import { api } from './useAPI'

const MAX_VIEWS = 50

export interface PinnedView {
  id: string
  name: string
  query: string
  /** 服务端原样返回 created_at（snake_case） */
  created_at: string
}

/**
 * 跨组件同步总线：home 页「固定」与 Sidebar 列表各持一个 hook 实例，
 * pin/unpin 后广播一次，让所有实例重新拉取，避免侧边栏停留旧数据。
 */
const bus = new EventTarget()
const CHANGED = 'changed'

export function usePinnedViews() {
  const [views, setViews] = useState<PinnedView[]>([])

  const refresh = useCallback(async () => {
    try {
      // api.get 直接返回解析后的响应体（数组本身），不是 { body } 包装
      const res = await api.get<PinnedView[]>('/pinned-views')
      if (Array.isArray(res)) setViews(res)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    refresh()
    const onChanged = () => refresh()
    bus.addEventListener(CHANGED, onChanged)
    return () => bus.removeEventListener(CHANGED, onChanged)
  }, [refresh])

  const pin = useCallback(async (name: string, query: string) => {
    if (views.length >= MAX_VIEWS) return false
    try {
      await api.post('/pinned-views', { name: name.trim().slice(0, 50), query })
      bus.dispatchEvent(new Event(CHANGED))
      return true
    } catch {
      return false
    }
  }, [views.length])

  const unpin = useCallback(async (id: string) => {
    try {
      await api.del(`/pinned-views/${id}`)
      bus.dispatchEvent(new Event(CHANGED))
    } catch { /* ignore */ }
  }, [])

  const isPinned = useCallback((query: string): boolean => {
    return views.some((v) => v.query === query)
  }, [views])

  return { views, pin, unpin, isPinned }
}
