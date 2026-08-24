import { describe, test, expect } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { findMermaidBlocks, mermaidPreview } from '../mermaidPreview'

function scan(doc: string): Array<{ from: number; to: number; src: string }> {
  const state = EditorState.create({ doc })
  return findMermaidBlocks(state)
}

/** 生成状态并统计 mermaidPreview 的 replace 装饰数（光标/选区在块内时应为 0） */
function decoCount(doc: string, anchor: number): number {
  const state = EditorState.create({ doc, selection: { anchor }, extensions: [mermaidPreview] })
  const deco = state.field(mermaidPreview).deco
  let count = 0
  const iter = deco.iter()
  while (iter.value) {
    count++
    iter.next()
  }
  return count
}

const MERMAID_DOC = ['```mermaid', 'graph TD', '  A --> B', '```'].join('\n')

describe('findMermaidBlocks', () => {
  test('识别 ```mermaid 围栏块（含围栏行，src 为内部文本）', () => {
    const blocks = scan(MERMAID_DOC)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].from).toBe(0)
    expect(blocks[0].to).toBe(MERMAID_DOC.length)
    expect(blocks[0].src).toBe('graph TD\n  A --> B')
  })

  test('多个图块', () => {
    const doc = ['```mermaid', 'graph TD', '```', '', 'text', '', '```mermaid', 'sequenceDiagram', '```'].join('\n')
    const blocks = scan(doc)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].src).toBe('graph TD')
    expect(blocks[1].src).toBe('sequenceDiagram')
  })

  test('普通代码围栏（```js）不误判', () => {
    const blocks = scan(['```js', 'const a = 1', '```'].join('\n'))
    expect(blocks).toHaveLength(0)
  })

  test('代码围栏内部的 mermaid 围栏不识别', () => {
    const blocks = scan(['```text', '```mermaid', 'graph TD', '```', '```'].join('\n'))
    expect(blocks).toHaveLength(0)
  })

  test('未闭合的 mermaid 围栏不识别', () => {
    const blocks = scan(['```mermaid', 'graph TD'].join('\n'))
    expect(blocks).toHaveLength(0)
  })

  test('空图块不装饰（留源码态便于编辑）', () => {
    const blocks = scan(['```mermaid', '```'].join('\n'))
    expect(blocks).toHaveLength(0)
  })
})

describe('mermaidPreview 装饰', () => {
  test('光标在块外生成 replace 装饰', () => {
    const doc = MERMAID_DOC + '\n\n后续文本'
    expect(decoCount(doc, doc.length)).toBe(1)
  })

  test('光标在块内（含围栏行）不渲染，回退源码', () => {
    expect(decoCount(MERMAID_DOC, 12)).toBe(0)
    expect(decoCount(MERMAID_DOC, 0)).toBe(0)
    expect(decoCount(MERMAID_DOC, MERMAID_DOC.length)).toBe(0)
  })

  test('选区变化复用块扫描缓存', () => {
    const doc = MERMAID_DOC + '\n\n后续文本'
    const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [mermaidPreview] })
    const next = state.update({ selection: { anchor: doc.length - 1 } }).state
    expect(next.field(mermaidPreview).blocks).toBe(state.field(mermaidPreview).blocks)
    expect(next.field(mermaidPreview).deco.size).toBe(1)
  })
})
