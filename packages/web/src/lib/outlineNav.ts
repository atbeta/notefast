/**
 * 大纲导航的纯逻辑：从「当前小节」反推它的祖先链。
 *
 * 解决的问题是长文档的方向感：读到一个 h3 时，能一眼看出它挂在哪个 h2 / h1 下。
 * 只用文字变深表达，不加指示条——指示条是「你在这里」，上级只是「你在这条线上」。
 *
 * 实现走**拍平列表**而不是树：阅读页的大纲本来就是从 buildHeadingTree 拍平来的
 * （层级深浅只体现在 depth 上），从当前项往前扫「depth 严格递减」的那些就是祖先链，
 * 一段循环说清，也不必为高亮再建一次树（lector outline.ts 的同一取舍）。
 */

export interface OutlineEntry {
  id: string
  depth: number
}

/** 当前项之前、depth 严格递减的那些项 id（由近及远）。当前项不在结果里。 */
export function ancestorHeadingIds(headings: readonly OutlineEntry[], activeId: string | null): string[] {
  if (!activeId) return []
  const idx = headings.findIndex((h) => h.id === activeId)
  if (idx <= 0) return []
  const out: string[] = []
  let depth = headings[idx]!.depth
  for (let i = idx - 1; i >= 0 && depth > 0; i--) {
    const d = headings[i]!.depth
    if (d < depth) {
      out.push(headings[i]!.id)
      depth = d
    }
  }
  return out
}
