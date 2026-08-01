import { StateField } from '@codemirror/state'
import type { EditorState, Extension, Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'

/**
 * 表格块内联预览：连续的 GFM pipe table（表头 + 分隔行 + 数据行）在光标不在块内时
 * 渲染为 HTML 表格；光标进入块内回退源码。与 imagePreview 同一模式，文档仍是 Markdown。
 * 判定逻辑对齐 core/markdown.ts 的 isTableRow / isTableDelimiter。
 */

function isTableRow(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && t.includes('|')
}

function isTableDelimiter(text: string): boolean {
  const t = text.trim()
  if (!t.includes('-')) return false
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|')
  if (cells.length === 0) return false
  return cells.every((c) => /^:?-+:?$/.test(c.trim()))
}

type Align = 'left' | 'center' | 'right'

interface ParsedTable {
  header: string[]
  aligns: Align[]
  body: string[][]
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

function parseTable(lines: string[]): ParsedTable {
  const header = splitRow(lines[0])
  const aligns = splitRow(lines[1]).map((c): Align =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left',
  )
  return { header, aligns, body: lines.slice(2).map(splitRow) }
}

/** asset:<sha256> 稳定引用 → API 路径（与 BlockRenderer 一致） */
function resolveSrc(raw: string): string {
  return raw.startsWith('asset:') ? `/api/v1/assets/${raw.slice(6)}` : raw
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 单元格内联 Markdown（精简版：图片/粗斜体/删除线/行内代码/链接） */
function inlineHtml(src: string): string {
  let s = escapeHtml(src)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, alt: string, url: string) => `<img class="cm-table-img" src="${resolveSrc(url)}" alt="${alt}">`)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  return s
}

class TableWidget extends WidgetType {
  constructor(
    readonly table: ParsedTable,
    readonly lineFrom: number,
  ) {
    super()
  }

  eq(other: TableWidget): boolean {
    return other.lineFrom === this.lineFrom && JSON.stringify(other.table) === JSON.stringify(this.table)
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-preview'
    const table = document.createElement('table')
    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    this.table.header.forEach((h, i) => {
      const th = document.createElement('th')
      th.style.textAlign = this.table.aligns[i] ?? 'left'
      th.innerHTML = inlineHtml(h)
      htr.appendChild(th)
    })
    thead.appendChild(htr)
    table.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (const row of this.table.body) {
      const tr = document.createElement('tr')
      row.forEach((c, i) => {
        const td = document.createElement('td')
        td.style.textAlign = this.table.aligns[i] ?? 'left'
        td.innerHTML = inlineHtml(c)
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    wrap.appendChild(table)
    // 点击表格把光标移入源码块，回退源码编辑
    // stopPropagation：阻止 CM 自己的指针选区逻辑在 widget 销毁后把光标映射到块外（会导致立即弹回 widget）
    wrap.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('a')) return
      e.preventDefault()
      e.stopPropagation()
      view.dispatch({ selection: { anchor: this.lineFrom } })
      view.focus()
    })
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

interface TableBlockRange {
  from: number
  to: number
  lines: string[]
}

/** 扫描文档找出所有表格块（跳过代码围栏内部，避免 fence 里的 | 误判）。
 *  表格紧跟 ATX 标题（## ...）时不识别为表格：lezer 会把「表头 + |---|---|」误判为 Setext 二级标题，
 *  对应的 syntax tree 不是 Table。Markdown 源层面仍是合法 GFM 表格，但交给预览渲染会与阅读态语义不一致；
 *  此处退回源码态，由阅读态的 core 解析负责正确呈现。 */
export function findTableBlocks(state: EditorState): TableBlockRange[] {
  const blocks: TableBlockRange[] = []
  let inFence = false
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i)
    if (/^\s*```/.test(line.text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (i + 1 > state.doc.lines) break
    const next = state.doc.line(i + 1)
    if (!isTableRow(line.text) || !isTableDelimiter(next.text)) continue
    const previous = i > 1 ? state.doc.line(i - 1).text.trim() : ''
    if (/^#{1,6}\s/.test(previous)) continue
    // 消耗后续表格行
    const lines = [line.text, next.text]
    let last = next
    let j = i + 2
    while (j <= state.doc.lines) {
      const l = state.doc.line(j)
      if (/^\s*```/.test(l.text)) break
      if (!isTableRow(l.text)) break
      lines.push(l.text)
      last = l
      j++
    }
    blocks.push({ from: line.from, to: last.to, lines })
    i = j - 1 // for 循环 i++ 后从 j 继续
  }
  return blocks
}

function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const sel = state.selection.main
  for (const block of findTableBlocks(state)) {
    // 光标 / 选区落在表格块内时显示源码，便于编辑
    if (sel.from <= block.to && sel.to >= block.from) continue
    ranges.push(
      Decoration.replace({
        widget: new TableWidget(parseTable(block.lines), block.from),
        block: true,
      }).range(block.from, block.to),
    )
  }
  return Decoration.set(ranges, true)
}

/** block 级 Decoration 必须由 StateField 提供（ViewPlugin 只支持行内装饰） */
export const tablePreview: Extension = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(deco, tr) {
    if (tr.docChanged || tr.selection) return buildDecorations(tr.state)
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})
