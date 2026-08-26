/**
 * 从 mdast 抽出围栏代码块的源码区间。
 * 与 `parseMarkdownToBlocksMdast` 同一套识别：认 `~~~`、按围栏长度匹配、未闭合延伸到文末；
 * 另合并已闭合的独占行 `$$`（language=math）。未闭合 `$$` 不延伸到文末，避免输入中途吞后文。
 * 编辑器预览用区间；未闭合反引号/波浪围栏仍返回，由调用方决定是否装饰。
 */

import { findExclusiveDollarMathSpans } from './displayMath'
import { fromNoteFastMarkdown } from './fromMarkdown'

export interface FencedCodeSpan {
  /** 含开闭围栏行，相对传入 markdown 的 offset（开围栏行前导空白算进 from） */
  from: number
  to: number
  language: string
  /** 围栏内部文本，不含围栏行 */
  value: string
  /** 是否有匹配长度的闭围栏；未闭合时 to 为文末 */
  closed: boolean
}

type MdNode = {
  type: string
  lang?: string | null
  value?: string
  children?: MdNode[]
  position?: {
    start: { offset?: number }
    end: { offset?: number }
  }
}

/** 仅 mdast 反引号 / 波浪围栏，不含 `$$`。给独占行公式扫描提供 occupied。 */
export function findMdastFencedCodeSpans(markdown: string): FencedCodeSpan[] {
  if (markdown === '') return []
  const tree = fromNoteFastMarkdown(markdown) as MdNode
  const out: FencedCodeSpan[] = []
  walk(tree.children, markdown, out)
  return out
}

export function findFencedCodeSpans(markdown: string): FencedCodeSpan[] {
  const mdast = findMdastFencedCodeSpans(markdown)
  const dollars = findExclusiveDollarMathSpans(markdown, mdast)
  if (dollars.length === 0) return mdast
  return [...mdast, ...dollars].sort((a, b) => a.from - b.from)
}

function walk(nodes: MdNode[] | undefined, markdown: string, out: FencedCodeSpan[]): void {
  if (!nodes) return
  for (const node of nodes) {
    if (node.type === 'code') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start == null || end == null) continue
      const from = lineStart(markdown, start)
      out.push({
        from,
        to: end,
        language: (node.lang ?? '').trim(),
        value: node.value ?? '',
        closed: fenceIsClosed(markdown, from, end),
      })
    }
    if (node.children?.length) walk(node.children, markdown, out)
  }
}

function lineStart(markdown: string, offset: number): number {
  const i = markdown.lastIndexOf('\n', offset - 1)
  return i < 0 ? 0 : i + 1
}

function fenceIsClosed(markdown: string, from: number, to: number): boolean {
  const lines = markdown.slice(from, to).split('\n')
  if (lines.length < 2) return false
  const open = lines[0].match(/^(\s*)([`~]{3,})/)
  if (!open) return false
  const marker = open[2][0]
  const len = open[2].length
  const close = lines[lines.length - 1]
  return new RegExp(`^\\s*${escapeRegex(marker)}{${len},}\\s*$`).test(close)
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
