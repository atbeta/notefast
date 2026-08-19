/**
 * 文档阅读态文内查找：纯偏移计算，不碰 DOM。
 * 高亮由 DocFindBar 用 Range + CSS Custom Highlight 画。
 */

export interface FindRange {
  start: number
  end: number
}

/** 大小写不敏感；空查询无命中。重叠命中按「上次起点+1」推进（如 Ababa / aba）。 */
export function findMatchRanges(haystack: string, query: string): FindRange[] {
  const q = query.trim()
  if (!q) return []
  const src = haystack.toLowerCase()
  const needle = q.toLowerCase()
  const out: FindRange[] = []
  let from = 0
  while (from < src.length) {
    const i = src.indexOf(needle, from)
    if (i < 0) break
    out.push({ start: i, end: i + needle.length })
    from = i + 1
  }
  return out
}

/** current=-1 表示尚未选中；dir=1 下一个，-1 上一个。count=0 时保持 -1。 */
export function stepFindIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1
  if (current < 0) return dir === 1 ? 0 : count - 1
  return (current + dir + count) % count
}

export const DOC_FIND_EVENT = 'nf:find'
export const DOC_FIND_NEXT_EVENT = 'nf:find-next'
export const DOC_FIND_PREV_EVENT = 'nf:find-prev'
