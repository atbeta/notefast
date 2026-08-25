import { describe, test, expect } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { findTableBlocks } from '../tablePreview'

function scan(doc: string): Array<{ from: number; to: number; rows: number }> {
  const state = EditorState.create({ doc })
  return findTableBlocks(state).map((b) => ({
    from: b.from,
    to: b.to,
    rows: b.lines.length,
  }))
}

describe('findTableBlocks', () => {
  test('基本 GFM 表格', () => {
    const blocks = scan([
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '| 3 | 4 |',
    ].join('\n'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0].rows).toBe(4)
  })

  test('跳过代码围栏内部的 |', () => {
    const blocks = scan([
      '```',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '```',
      '| x | y |',
      '|---|---|',
      '| 9 | 9 |',
    ].join('\n'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0].rows).toBe(3)
  })

  test('跳过 ~~~ 围栏内部的 |', () => {
    const blocks = scan([
      '~~~',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '~~~',
      '| x | y |',
      '|---|---|',
      '| 9 | 9 |',
    ].join('\n'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0].rows).toBe(3)
  })

  test('ATX 标题紧跟表格时跳过（lezer Setext 误判守卫）', () => {
    const blocks = scan([
      '## 附录',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n'))
    expect(blocks).toHaveLength(0)
  })

  test('ATX 标题与表格之间有空行则正常识别', () => {
    const blocks = scan([
      '## 附录',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0].rows).toBe(3)
  })

  test('分隔行不存在则不识别', () => {
    const blocks = scan([
      '| a | b |',
      'not a delimiter',
    ].join('\n'))
    expect(blocks).toHaveLength(0)
  })

  test('无表头直接收集中止', () => {
    const blocks = scan([
      '| a | b |',
      '|---|---|',
      'paragraph',
      '| c | d |',
      '|---|---|',
    ].join('\n'))
    expect(blocks).toHaveLength(2)
    expect(blocks.map((b) => b.rows)).toEqual([2, 2])
  })
})
