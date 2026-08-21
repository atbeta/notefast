import { describe, test, expect } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { ghostDecorations, ghostTextExtension, setGhostText } from '../ghostText'

function rangesOf(state: EditorState): Array<{ from: number; to: number }> {
  const deco = state.field(ghostDecorations)
  const out: Array<{ from: number; to: number }> = []
  const iter = deco.iter()
  while (iter.value) {
    out.push({ from: iter.from, to: iter.to })
    iter.next()
  }
  return out
}

describe('ghostText 装饰', () => {
  test('续写：幽灵字插在光标处（零宽 widget）', () => {
    const state = EditorState.create({
      doc: 'hello world',
      selection: { anchor: 5 },
      extensions: ghostTextExtension,
    }).update({
      effects: setGhostText.of({ text: ' there', hint: ' Tab' }),
    }).state
    expect(rangesOf(state)).toEqual([{ from: 5, to: 5 }])
  })

  test('改写：原文区间保留，幽灵字钉在选区末', () => {
    const state = EditorState.create({
      doc: 'hello world',
      selection: { anchor: 0 },
      extensions: ghostTextExtension,
    }).update({
      effects: setGhostText.of({ text: '地球', hint: ' Tab', from: 6, to: 11 }),
    }).state
    const ranges = rangesOf(state)
    expect(ranges.some((r) => r.from === 6 && r.to === 11)).toBe(true)
    expect(ranges.some((r) => r.from === 11 && r.to === 11)).toBe(true)
  })
})
