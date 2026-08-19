/**
 * 文档阅读列滚动位置：sessionStorage，按 docId 隔离。
 * 关掉标签页即丢；刷新/切篇再回来仍在。
 */

export const DOC_SCROLL_KEY_PREFIX = 'nf:doc-scroll:'

export function readDocScroll(docId: string): number | null {
  const id = docId.trim()
  if (!id) return null
  try {
    const raw = sessionStorage.getItem(DOC_SCROLL_KEY_PREFIX + id)
    if (raw == null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

export function writeDocScroll(docId: string, top: number): void {
  const id = docId.trim()
  if (!id || !Number.isFinite(top) || top < 0) return
  try {
    sessionStorage.setItem(DOC_SCROLL_KEY_PREFIX + id, String(Math.round(top)))
  } catch {
    /* quota / 隐私模式 */
  }
}
