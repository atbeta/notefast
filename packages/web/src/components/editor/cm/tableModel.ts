/**
 * GFM 管道表格的解析 / 序列化 / 网格变更。
 *
 * 供编辑器预览 widget 与外挂表格对话框共用。不进 core：阅读态仍走 markdown.ts 整段管道文本，
 * 这里只服务「人类改格子 → 写回 Markdown」这一条路径。
 *
 * 单元格内 `|` 以 `\|` 转义（GFM 惯例）；对齐保留 none / left / center / right。
 */

export type TableAlign = 'none' | 'left' | 'center' | 'right'

export interface ParsedTable {
  header: string[]
  aligns: TableAlign[]
  body: string[][]
}

/** 表格行：行内含 | 且非空白（对齐 core/markdown.ts） */
export function isTableRow(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && t.includes('|')
}

/** 表格分隔行：| --- | :--- | ---: | :---: | 形态 */
export function isTableDelimiter(text: string): boolean {
  const t = text.trim()
  if (!t.includes('-')) return false
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|')
  if (cells.length === 0) return false
  return cells.every((c) => /^:?-+:?$/.test(c.trim()))
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (t[i] === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += t[i]
  }
  cells.push(cur.trim())
  return cells
}

function parseAlign(cell: string): TableAlign {
  const t = cell.trim()
  const left = t.startsWith(':')
  const right = t.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return 'none'
}

export function parseTable(lines: string[]): ParsedTable {
  const header = splitRow(lines[0] ?? '')
  const aligns = splitRow(lines[1] ?? '').map(parseAlign)
  return { header, aligns, body: lines.slice(2).map(splitRow) }
}

export function colCount(table: ParsedTable): number {
  return Math.max(1, table.header.length, table.aligns.length, ...table.body.map((r) => r.length))
}

export function padTable(table: ParsedTable): ParsedTable {
  const n = colCount(table)
  const pad = (row: string[]): string[] => Array.from({ length: n }, (_, i) => row[i] ?? '')
  return {
    header: pad(table.header),
    aligns: Array.from({ length: n }, (_, i) => table.aligns[i] ?? 'none'),
    body: table.body.map(pad),
  }
}

export function tablesEqual(a: ParsedTable, b: ParsedTable): boolean {
  return JSON.stringify(padTable(a)) === JSON.stringify(padTable(b))
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|')
}

function alignDelim(align: TableAlign): string {
  if (align === 'left') return ':---'
  if (align === 'right') return '---:'
  if (align === 'center') return ':---:'
  return '---'
}

function serializeRow(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`
}

export function serializeTable(table: ParsedTable): string {
  const t = padTable(table)
  const delim = `| ${t.aligns.map(alignDelim).join(' | ')} |`
  return [serializeRow(t.header), delim, ...t.body.map(serializeRow)].join('\n')
}

/** row = -1 改表头 */
export function setCell(table: ParsedTable, row: number, col: number, value: string): ParsedTable {
  const t = padTable(table)
  if (row < 0) {
    const header = [...t.header]
    if (col < 0 || col >= header.length) return t
    header[col] = value
    return { ...t, header }
  }
  const body = t.body.map((r, i) =>
    i === row ? r.map((c, j) => (j === col ? value : c)) : r,
  )
  return { ...t, body }
}

export function addRow(table: ParsedTable, at?: number): ParsedTable {
  const t = padTable(table)
  const empty = t.header.map(() => '')
  const idx = at ?? t.body.length
  const body = [...t.body]
  body.splice(idx, 0, empty)
  return { ...t, body }
}

export function addCol(table: ParsedTable, at?: number): ParsedTable {
  const t = padTable(table)
  const idx = at ?? t.header.length
  const insert = <T>(arr: T[], v: T): T[] => {
    const next = [...arr]
    next.splice(idx, 0, v)
    return next
  }
  return {
    header: insert(t.header, ''),
    aligns: insert(t.aligns, 'none'),
    body: t.body.map((r) => insert(r, '')),
  }
}

export function deleteRow(table: ParsedTable, row: number): ParsedTable {
  const t = padTable(table)
  if (row < 0 || row >= t.body.length) return t
  return { ...t, body: t.body.filter((_, i) => i !== row) }
}

/** 至少保留 1 列 */
export function deleteCol(table: ParsedTable, col: number): ParsedTable {
  const t = padTable(table)
  if (t.header.length <= 1) return t
  if (col < 0 || col >= t.header.length) return t
  const drop = <T>(arr: T[]): T[] => arr.filter((_, i) => i !== col)
  return {
    header: drop(t.header),
    aligns: drop(t.aligns),
    body: t.body.map(drop),
  }
}

/** 工具栏插入用的空表：2 列 × 表头 + 2 行 */
export function blankTable(cols = 2, bodyRows = 2): ParsedTable {
  const n = Math.max(1, cols)
  const empty = (): string[] => Array.from({ length: n }, () => '')
  return {
    header: empty(),
    aligns: Array.from({ length: n }, () => 'none' as const),
    body: Array.from({ length: Math.max(0, bodyRows) }, empty),
  }
}

/**
 * 插入表格时的前后填充：保证表前有空行（ATX 标题紧贴表格时预览会跳过）。
 * beforeChar = 插入点前一个字符；文档开头传 null 且 atDocStart=true。
 */
export function tableInsertAffixes(
  beforeChar: string | null,
  atDocStart: boolean,
): { prefix: string; suffix: string } {
  if (atDocStart) return { prefix: '', suffix: '\n' }
  if (beforeChar === '\n') return { prefix: '\n', suffix: '\n' }
  return { prefix: '\n\n', suffix: '\n' }
}
