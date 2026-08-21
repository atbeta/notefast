/**
 * 首页标签云会话缓存：GET /tags 与文档列表分次返回，无缓存时 chip 行晚到会把列表顶下去。
 * 模块级单例 + in-flight 去重；有旧数据先画，后台刷新。
 */

import type { TagInfo } from '@notefast/core'

export interface TagCatalogPayload {
  provider: string
  tags: TagInfo[]
}

let cache: TagCatalogPayload | null = null
let inflight: Promise<TagCatalogPayload> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** 当前缓存（可能为 null）。 */
export function peekTagCatalog(): TagCatalogPayload | null {
  return cache
}

export function subscribeTagCatalog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function rememberTagCatalog(data: TagCatalogPayload): void {
  cache = data
  emit()
}

/** 拉取标签云；已有 in-flight 则复用，避免 Layout / Home / TagFilter 各打一遍。 */
export function loadTagCatalog(
  fetcher: () => Promise<TagCatalogPayload>,
): Promise<TagCatalogPayload> {
  if (inflight) return inflight
  inflight = fetcher()
    .then((data) => {
      rememberTagCatalog(data)
      return data
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 测试用：清空缓存与 in-flight。 */
export function resetTagCatalog(): void {
  cache = null
  inflight = null
}
