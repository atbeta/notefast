import { findFencedCodeSpans, type Block } from '@notefast/core'

export interface MarkdownBlockSpan {
  from: number
  to: number
  content: string
}

/** 正文块前序（不含文档根）。与编辑器 strip 标题后的 markdown 块序对齐。 */
export function flattenBodyBlocks(root: Block): Block[] {
  const out: Block[] = []
  const walk = (b: Block) => {
    if (b.type !== 'document') out.push(b)
    for (const child of b.children ?? []) walk(child)
  }
  walk(root)
  return out
}

/**
 * 把编辑器 markdown 切成与解析器大致同序的块区间，用来把光标映射到已保存块。
 * 不追求与 parseMarkdownToBlocks 逐字等价；围栏范围与 core mapper 共用 mdast（含 ~~~ / $$）。
 */
export function scanMarkdownBlocks(markdown: string): MarkdownBlockSpan[] {
  const text = markdown.replace(/\r\n/g, '\n')
  const fences = findFencedCodeSpans(text)
  const spans: MarkdownBlockSpan[] = []
  let pos = 0
  const rows: Array<{ line: string; from: number; to: number }> = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const from = pos
    const to = pos + line.length
    rows.push({ line, from, to })
    pos = to + (i < lines.length - 1 ? 1 : 0)
  }

  const fenceAt = (offset: number) => fences.find((s) => offset >= s.from && offset < s.to)

  let i = 0
  const advance = () => { i += 1 }

  while (i < rows.length) {
    const row = rows[i]!
    const fence = fenceAt(row.from)
    if (fence) {
      spans.push({ from: fence.from, to: fence.to, content: fence.value })
      while (i < rows.length && rows[i]!.from < fence.to) i += 1
      continue
    }

    if (row.line.trim() === '') {
      advance()
      continue
    }

    if (/^#{1,6}\s/.test(row.line)) {
      spans.push({
        from: row.from,
        to: row.to,
        content: row.line.replace(/^#{1,6}\s+/, ''),
      })
      advance()
      continue
    }

    if (/^(\s*)([-*+]|\d+\.)\s+/.test(row.line)) {
      spans.push({
        from: row.from,
        to: row.to,
        content: row.line
          .replace(/^(\s*)([-*+]|\d+\.)\s+/, '')
          .replace(/^\[( |x|X)\]\s+/, ''),
      })
      advance()
      continue
    }

    if (/^>/.test(row.line)) {
      const from = row.from
      const buf = [row.line.replace(/^>\s?/, '')]
      let to = row.to
      advance()
      while (i < rows.length) {
        const next = rows[i]!
        if (fenceAt(next.from) || !/^>/.test(next.line) || next.line.trim() === '') break
        buf.push(next.line.replace(/^>\s?/, ''))
        to = next.to
        advance()
      }
      spans.push({ from, to, content: buf.join('\n') })
      continue
    }

    const from = row.from
    const buf = [row.line]
    let to = row.to
    advance()
    while (i < rows.length) {
      const next = rows[i]!
      if (
        next.line.trim() === ''
        || fenceAt(next.from)
        || /^#{1,6}\s/.test(next.line)
        || /^(\s*)([-*+]|\d+\.)\s+/.test(next.line)
        || /^>/.test(next.line)
      ) break
      buf.push(next.line)
      to = next.to
      advance()
    }
    spans.push({ from, to, content: buf.join('\n').trim() })
  }

  return spans
}

/**
 * 编辑器光标 → 已保存正文块。对不上（空文、尚未落盘的新段）返回 null，调用方用根块。
 */
export function resolveRelatedBlockId(doc: Block, markdown: string, offset: number): string | null {
  const saved = flattenBodyBlocks(doc)
  if (saved.length === 0) return null
  const pieces = scanMarkdownBlocks(markdown)
  if (pieces.length === 0) return null

  let idx = pieces.findIndex((p, i) => {
    const next = pieces[i + 1]
    return offset >= p.from && offset < (next?.from ?? Number.POSITIVE_INFINITY)
  })
  if (idx < 0) idx = offset <= pieces[0]!.from ? 0 : pieces.length - 1
  if (idx >= saved.length) return saved[saved.length - 1]!.id
  return saved[idx]!.id
}
