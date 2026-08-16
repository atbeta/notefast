import { describe, test, expect } from 'bun:test'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { expandEmptyFence } from '../keymap'

function makeView(doc: string, cursor: number): EditorView {
  let state = EditorState.create({
    doc,
    selection: { anchor: cursor },
  })
  const view: EditorView = {
    get state() {
      return state
    },
    dispatch(tr: Parameters<EditorView['dispatch']>[0]) {
      const next = state.update({ changes: tr.changes, selection: tr.selection })
      state = next.state
    },
  } as unknown as EditorView
  return view
}

describe('expandEmptyFence', () => {
  test('``` 行末回车展开为空代码块', () => {
    const view = makeView('```', 3)
    expect(expandEmptyFence(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('```\n\n```')
    expect(view.state.selection.main.anchor).toBe(4)
  })

  test('非围栏行返回 false', () => {
    const view = makeView('hello', 5)
    expect(expandEmptyFence(view)).toBe(false)
  })

  test('光标不在行末返回 false', () => {
    const view = makeView('``` more', 3)
    expect(expandEmptyFence(view)).toBe(false)
  })

  test('偶数个前置围栏（当前 fence 是关闭符）时跳过', () => {
    const view = makeView('```\ncode\n```', 11)
    expect(expandEmptyFence(view)).toBe(false)
  })

  test('保留缩进', () => {
    const view = makeView('  ```', 5)
    expect(expandEmptyFence(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('  ```\n  \n  ```')
  })
})
