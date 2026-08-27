import type { SearchResult } from '@notefast/core'

/** ⌘K 展示的去重后文档条数 */
export const PALETTE_DOC_LIMIT = 8
/** 去重前多取几条 block，避免一篇长文占满 8 个坑 */
export const PALETTE_SEARCH_OVERFETCH = 32

/**
 * 词法命中按文档去重，保留每篇第一次出现（相关度已排好）。
 * 命令面板仍是一篇一行，但保留最佳 block，打开时落到该块。
 */
export function collapseSearchHitsByDoc(hits: SearchResult[], limit: number): SearchResult[] {
  const seen = new Set<string>()
  const out: SearchResult[] = []
  for (const h of hits) {
    const docId = h.block.root_id || h.block.id
    if (seen.has(docId)) continue
    seen.add(docId)
    out.push(h)
    if (out.length >= limit) break
  }
  return out
}

/** 打开命中文档：子块带 #block- 锚（阅读态已有 hash 滚动）；标题命中只开篇。 */
export function searchHitDocPath(hit: SearchResult): string {
  const docId = hit.block.root_id || hit.block.id
  if (!hit.block.id || hit.block.id === docId) return `/doc/${docId}`
  return `/doc/${docId}#block-${hit.block.id}`
}

/**
 * 文档页定位锚：`#block-<id>`（搜索/引用）或 `#<id>`（大纲）。
 * 有锚时不要先 restore 阅读滚动再跳转，否则会上下晃。
 */
export function parseDocScrollHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  return raw.startsWith('block-') ? raw.slice(6) : raw
}

/** 面板主行用文档标题，不要用子块 snippet 冒充篇名 */
export function paletteDocTitle(hit: SearchResult, untitled: string): string {
  const fromApi = hit.doc_title?.trim()
  if (fromApi) return fromApi
  if (hit.block.root_id === hit.block.id) {
    const t = hit.block.content.trim()
    if (t) return t
  }
  return untitled
}
