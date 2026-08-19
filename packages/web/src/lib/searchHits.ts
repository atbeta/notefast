import type { SearchResult } from '@notefast/core'

/** ⌘K 展示的去重后文档条数 */
export const PALETTE_DOC_LIMIT = 8
/** 去重前多取几条 block，避免一篇长文占满 8 个坑 */
export const PALETTE_SEARCH_OVERFETCH = 32

/**
 * 词法命中按文档去重，保留每篇第一次出现（相关度已排好）。
 * 命令面板 / 归档搜索都是「打开哪一篇」，不是定位到哪个 block。
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
