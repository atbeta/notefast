import { describe, test, expect } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { findMathBlocks, mathPreview } from '../mathPreview'

function scan(doc: string): Array<{ from: number; to: number; src: string }> {
  const state = EditorState.create({ doc })
  return findMathBlocks(state)
}

/** 生成状态并统计 mathPreview 的 replace 装饰数（光标/选区在块内时应为 0） */
function decoCount(doc: string, anchor: number): number {
  const state = EditorState.create({ doc, selection: { anchor }, extensions: [mathPreview] })
  const deco = state.field(mathPreview)
  let count = 0
  const iter = deco.iter()
  while (iter.value) {
    count++
    iter.next()
  }
  return count
}

const MATH_DOC = ['```math', 'E = mc^2', '```'].join('\n')

describe('findMathBlocks', () => {
  test('识别 ```math 围栏块（含围栏行，src 为内部文本）', () => {
    const blocks = scan(MATH_DOC)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].from).toBe(0)
    expect(blocks[0].to).toBe(MATH_DOC.length)
    expect(blocks[0].src).toBe('E = mc^2')
  })

  test('别名围栏 latex / katex / tex 均识别', () => {
    for (const lang of ['latex', 'katex', 'tex']) {
      const blocks = scan(['```' + lang, 'x^2', '```'].join('\n'))
      expect(blocks).toHaveLength(1)
      expect(blocks[0].src).toBe('x^2')
    }
  })

  test('多行公式与多个块', () => {
    const doc = ['```math', 'a^2', '+ b^2', '```', '', 'text', '', '```math', 'c^2', '```'].join('\n')
    const blocks = scan(doc)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].src).toBe('a^2\n+ b^2')
    expect(blocks[1].src).toBe('c^2')
  })

  test('普通代码围栏（```js）不误判', () => {
    const blocks = scan(['```js', 'const a = 1', '```'].join('\n'))
    expect(blocks).toHaveLength(0)
  })

  test('代码围栏内部的 math 围栏不识别', () => {
    const blocks = scan(['```text', '```math', 'E=mc^2', '```', '```'].join('\n'))
    expect(blocks).toHaveLength(0)
  })

  test('未闭合的 math 围栏不识别', () => {
    const blocks = scan(['```math', 'E=mc^2'].join('\n'))
    expect(blocks).toHaveLength(0)
  })

  test('空公式块不装饰（留源码态便于编辑）', () => {
    const blocks = scan(['```math', '```'].join('\n'))
    expect(blocks).toHaveLength(0)
  })
})

describe('mathPreview 装饰', () => {
  test('光标在块外生成 replace 装饰', () => {
    const doc = MATH_DOC + '\n\n后续文本'
    expect(decoCount(doc, doc.length)).toBe(1)
  })

  test('光标在块内（含围栏行）不渲染，回退源码', () => {
    // 内容行内部
    expect(decoCount(MATH_DOC, 8)).toBe(0)
    // 开围栏行首
    expect(decoCount(MATH_DOC, 0)).toBe(0)
    // 闭围栏行
    expect(decoCount(MATH_DOC, MATH_DOC.length)).toBe(0)
  })
})
