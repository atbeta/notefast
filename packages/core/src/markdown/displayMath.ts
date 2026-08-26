/**
 * 独占行 `$$` 块级公式（A-4）。
 *
 * 不引入 remark-math：行内 `$` 仍留在 paragraph content，由阅读态 INLINE_MATH_SRC 渲染。
 * 只认整行（可带首尾空白）的 `$$` 开闭对；单行 `$$x$$`、未闭合、代码围栏内的 `$$` 都不提升。
 * 映射仍是 `code + language: math`，导出继续走 ```math。
 */

import type { FencedCodeSpan } from './fencedCode'

const DOLLAR_LINE = /^\s*\$\$\s*$/

interface LineRow {
  from: number
  to: number
  text: string
}

export function isExclusiveDollarFenceLine(line: string): boolean {
  return DOLLAR_LINE.test(line)
}

export function findExclusiveDollarMathSpans(
  markdown: string,
  occupied: ReadonlyArray<{ from: number; to: number }>,
): FencedCodeSpan[] {
  if (markdown === '') return []
  const rows = splitLines(markdown)
  const out: FencedCodeSpan[] = []
  let i = 0
  while (i < rows.length) {
    const open = rows[i]!
    if (isOccupied(open.from, occupied) || !isExclusiveDollarFenceLine(open.text)) {
      i += 1
      continue
    }
    let closeIdx = -1
    for (let j = i + 1; j < rows.length; j++) {
      const row = rows[j]!
      if (isOccupied(row.from, occupied)) continue
      if (isExclusiveDollarFenceLine(row.text)) {
        closeIdx = j
        break
      }
    }
    if (closeIdx < 0) {
      i += 1
      continue
    }
    const close = rows[closeIdx]!
    const innerFrom = open.to < markdown.length ? open.to + 1 : open.to
    let value = markdown.slice(innerFrom, close.from)
    if (value.endsWith('\n')) value = value.slice(0, -1)
    out.push({
      from: open.from,
      to: close.to,
      language: 'math',
      value,
      closed: true,
    })
    i = closeIdx + 1
  }
  return out
}

/** 把已闭合的独占行 $$ 改写成 ```math，供 mdast 映射。位置以改写后文本为准。 */
export function rewriteClosedExclusiveDollarMath(
  markdown: string,
  occupied: ReadonlyArray<{ from: number; to: number }>,
): string {
  const spans = findExclusiveDollarMathSpans(markdown, occupied)
  if (spans.length === 0) return markdown
  let out = markdown
  for (const span of [...spans].sort((a, b) => b.from - a.from)) {
    out = replaceDollarFence(out, span)
  }
  return out
}

function replaceDollarFence(markdown: string, span: FencedCodeSpan): string {
  const region = markdown.slice(span.from, span.to)
  const lines = region.split('\n')
  if (lines.length < 2) return markdown
  const openIndent = /^\s*/.exec(lines[0]!)?.[0] ?? ''
  const closeIndent = /^\s*/.exec(lines[lines.length - 1]!)?.[0] ?? ''
  lines[0] = `${openIndent}\`\`\`math`
  lines[lines.length - 1] = `${closeIndent}\`\`\``
  return markdown.slice(0, span.from) + lines.join('\n') + markdown.slice(span.to)
}

function splitLines(markdown: string): LineRow[] {
  const rows: LineRow[] = []
  let pos = 0
  const parts = markdown.split('\n')
  for (let i = 0; i < parts.length; i++) {
    const text = parts[i]!
    const from = pos
    const to = pos + text.length
    rows.push({ from, to, text })
    pos = to + (i < parts.length - 1 ? 1 : 0)
  }
  return rows
}

function isOccupied(offset: number, ranges: ReadonlyArray<{ from: number; to: number }>): boolean {
  return ranges.some((r) => offset >= r.from && offset < r.to)
}
