/**
 * 首页标签筛选：chip 两行折叠 + 单击/加选的纯逻辑（与 URL 写入解耦，便于单测）。
 */

export const TAG_CHIP_MAX_ROWS = 2

export interface TagCount {
  tag: string
  count: number
}

/** 从 `?tags=` / 兼容 `?tag=` 读出已选标签（去重、小写、排序）。 */
export function readSelectedTags(params: URLSearchParams): string[] {
  const fromMulti = (params.get('tags') || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
  const single = (params.get('tag') || '').trim().toLowerCase()
  const set = new Set(fromMulti)
  if (single) set.add(single)
  return Array.from(set).sort()
}

/** URL 里有、列表没有的标签跟在末尾，不打乱 count 排序。 */
export function catalogWithSelected(all: TagCount[], selected: string[]): TagCount[] {
  const have = new Set(all.map((t) => t.tag))
  const extra = selected.filter((s) => !have.has(s)).map((s) => ({ tag: s, count: 0 }))
  return extra.length > 0 ? [...all, ...extra] : all
}

/**
 * 在 maxRows 行内能放下多少个 chip。
 * 若还有剩余，最后一行预留 trailingWidth（展开按钮）+ 一个 gap。
 * `containerWidth <= 0` 时视为尚未布局，返回全部以免首帧闪空。
 */
export function chipCountForRows(
  widths: number[],
  containerWidth: number,
  gapX: number,
  maxRows: number,
  trailingWidth: number,
): number {
  const n = widths.length
  if (n === 0 || containerWidth <= 0) return n
  let row = 1
  let used = 0
  for (let i = 0; i < n; i++) {
    const w = widths[i]!
    const last = i === n - 1
    const reserve = !last && row === maxRows ? gapX + trailingWidth : 0
    const gap = used === 0 ? 0 : gapX
    if (used > 0 && used + gap + w + reserve > containerWidth) {
      row += 1
      if (row > maxRows) return i
      used = w
      continue
    }
    used += gap + w
  }
  return n
}

/**
 * 下一次选中集合。
 * - additive（⌘/Ctrl）：加/减该标签
 * - 单击已选中：去掉该项（最后一项则清空 → 所有文档）
 * - 单击未选中：替换为仅此标签
 */
export function nextTagSelection(selected: string[], tag: string, additive: boolean): string[] {
  const has = selected.includes(tag)
  if (additive) return has ? selected.filter((t) => t !== tag) : [...selected, tag]
  if (has) return selected.filter((t) => t !== tag)
  return [tag]
}

export function isAdditiveTagClick(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey
}
