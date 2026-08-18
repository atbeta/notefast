import { describe, test, expect } from 'bun:test'
import {
  parseTable,
  serializeTable,
  tablesEqual,
  addRow,
  addCol,
  deleteRow,
  deleteCol,
  setCell,
  padTable,
  blankTable,
  tableInsertAffixes,
} from '../tableModel'

describe('parseTable / serializeTable', () => {
  test('基本 GFM 表格 roundtrip 单元格与对齐', () => {
    const lines = [
      '| 名称 | 数量 |',
      '| :--- | ---: |',
      '| 苹果 | 3 |',
    ]
    const table = parseTable(lines)
    expect(table.header).toEqual(['名称', '数量'])
    expect(table.aligns).toEqual(['left', 'right'])
    expect(table.body).toEqual([['苹果', '3']])
    const again = parseTable(serializeTable(table).split('\n'))
    expect(again.header).toEqual(table.header)
    expect(again.aligns).toEqual(table.aligns)
    expect(again.body).toEqual(table.body)
  })

  test('无冒号分隔行解析为 none 对齐', () => {
    const table = parseTable(['| a | b |', '| --- | --- |', '| 1 | 2 |'])
    expect(table.aligns).toEqual(['none', 'none'])
  })

  test('单元格内管道符 \\| 解析为字面 |，序列化再转义', () => {
    const table = parseTable(['| a \\| b | c |', '| --- | --- |', '| x | y |'])
    expect(table.header).toEqual(['a | b', 'c'])
    const md = serializeTable(table)
    expect(md).toContain('a \\| b')
    expect(parseTable(md.split('\n')).header).toEqual(['a | b', 'c'])
  })

  test('参差行列按表头列数补齐空单元格', () => {
    const table = padTable(parseTable(['| a | b | c |', '|---|---|---|', '| 1 | 2 |']))
    expect(table.body[0]).toEqual(['1', '2', ''])
  })
})

describe('tablesEqual', () => {
  test('仅空白差异视为相等', () => {
    const a = parseTable(['| a | b |', '|---|---|', '| 1 | 2 |'])
    const b = parseTable(['|  a  | b |', '| --- | --- |', '| 1 | 2 |'])
    expect(tablesEqual(a, b)).toBe(true)
  })

  test('改单元格后不相等', () => {
    const a = parseTable(['| a | b |', '|---|---|', '| 1 | 2 |'])
    const b = setCell(a, 0, 0, '9')
    expect(tablesEqual(a, b)).toBe(false)
  })
})

describe('grid mutations', () => {
  const base = () => parseTable(['| a | b |', '|---|---|', '| 1 | 2 |'])

  test('setCell 改表头（row = -1）与表体', () => {
    let t = setCell(base(), -1, 0, 'A')
    t = setCell(t, 0, 1, 'X')
    expect(t.header[0]).toBe('A')
    expect(t.body[0][1]).toBe('X')
  })

  test('addRow 默认追加空行', () => {
    const t = addRow(base())
    expect(t.body).toHaveLength(2)
    expect(t.body[1]).toEqual(['', ''])
  })

  test('addCol 默认追加空列并保留对齐长度', () => {
    const t = addCol(base())
    expect(t.header).toEqual(['a', 'b', ''])
    expect(t.aligns).toHaveLength(3)
    expect(t.body[0]).toEqual(['1', '2', ''])
  })

  test('deleteRow 可删到 0 行', () => {
    const t = deleteRow(base(), 0)
    expect(t.body).toEqual([])
  })

  test('deleteCol 拒绝删到 0 列', () => {
    let t = deleteCol(base(), 1)
    expect(t.header).toEqual(['a'])
    t = deleteCol(t, 0)
    expect(t.header).toEqual(['a'])
  })
})

describe('blankTable / tableInsertAffixes', () => {
  test('空表序列化为可再解析的 2 列 2 行 GFM', () => {
    const md = serializeTable(blankTable())
    const lines = md.split('\n')
    expect(lines).toHaveLength(4)
    const t = parseTable(lines)
    expect(t.header).toEqual(['', ''])
    expect(t.body).toEqual([['', ''], ['', '']])
  })

  test('文档开头不额外加空行', () => {
    expect(tableInsertAffixes(null, true)).toEqual({ prefix: '', suffix: '\n' })
  })

  test('已在行首则只补一个换行，避免紧贴标题', () => {
    expect(tableInsertAffixes('\n', false)).toEqual({ prefix: '\n', suffix: '\n' })
  })

  test('行中插入时前后都空一行', () => {
    expect(tableInsertAffixes('x', false)).toEqual({ prefix: '\n\n', suffix: '\n' })
  })
})
