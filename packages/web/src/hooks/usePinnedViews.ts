import { useState, useEffect, useCallback } from 'react'
import { api } from './useAPI'
import { currentLocale } from '../lib/time'

const MAX_VIEWS = 50

/**
 * 规范化视图 query：统一去掉前导 ?。
 * 历史上 pin 存过带 ? 的形式（buildListQuery 返回值），Sidebar 再拼 `/?` 前缀
 * 会产生 `/??tags=...` 双问号链接，URLSearchParams 解析不出 tags 导致不过滤。
 * 读侧统一 canonical 化，兼容已存库的旧数据。
 */
export function canonicalViewQuery(q: string): string {
  return q.replace(/^[?]+/, '')
}

export interface PinnedView {
  id: string
  name: string
  query: string
  /** 服务端原样返回 created_at（snake_case） */
  created_at: string
}

/**
 * 按名称排序（locale 感知：中文按拼音、英文按字母、数字前缀自然序）。
 * 固定视图没有拖拽排序，用户用 01- / 02- 前缀即可控制展示顺序。
 */
export function sortPinnedViewsByName(views: PinnedView[]): PinnedView[] {
  const collator = new Intl.Collator(currentLocale(), { numeric: true, sensitivity: 'base' })
  return [...views].sort((a, b) => collator.compare(a.name, b.name))
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
      if (Array.isArray(res)) setViews(sortPinnedViewsByName(res))
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
      await api.post('/pinned-views', { name: name.trim().slice(0, 50), query: canonicalViewQuery(query) })
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

  const rename = useCallback(async (id: string, name: string) => {
    try {
      await api.patch(`/pinned-views/${id}`, { name: name.trim().slice(0, 50) })
      bus.dispatchEvent(new Event(CHANGED))
    } catch { /* ignore */ }
  }, [])

  const isPinned = useCallback((query: string): boolean => {
    const target = canonicalViewQuery(query)
    return views.some((v) => canonicalViewQuery(v.query) === target)
  }, [views])

  return { views, pin, unpin, rename, isPinned }
}
