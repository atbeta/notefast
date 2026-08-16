import { describe, test, expect } from 'bun:test'
import { EditorState } from '@codemirror/state'

/**
 * 回归测试：CRLF 文档 dispatch 时 selection 越界（白屏根因）
 *
 * 现象：zip 导入的 Windows md（\r\n 换行）打开编辑即白屏，
 * 报 RangeError("Selection points outside of document")。
 * 根因：CM 6 把 \r\n 规范化为 \n（每个 CRLF 少 1 字符），而外部 value 更新
 * 用原始字符串长度（含 \r）做 selection anchor → 超出规范化后的 doc 长度。
 */
describe('CodeMirror CRLF 规范化与 selection', () => {
  test('CRLF 文档：用原始长度做 anchor 会越界抛错', () => {
    const propsValue = '# Title\r\n\r\n第一段\r\n第二段\r\n'
    const state = EditorState.create({ doc: '' })
    expect(() =>
      state.update({
        changes: { from: 0, to: 0, insert: propsValue },
        selection: { anchor: propsValue.length }, // 旧行为：含 \r 的长度
      }),
    ).toThrow('Selection points outside of document')
  })

  test('CRLF 文档：anchor 按规范化长度（\r\n→\n）不越界', () => {
    const propsValue = '# Title\r\n\r\n第一段\r\n第二段\r\n'
    const state = EditorState.create({ doc: '' })
    const normalized = propsValue.replace(/\r\n/g, '\n')
    const next = state.update({
      changes: { from: 0, to: 0, insert: propsValue },
      selection: { anchor: normalized.length },
    })
    // CM 内部 doc 已规范化：长度等于 anchor
    expect(next.state.doc.length).toBe(normalized.length)
    expect(next.state.selection.main.anchor).toBe(normalized.length)
  })

  test('LF 文档不受影响（anchor = 原始长度 = 规范化长度）', () => {
    const propsValue = '# Title\n\n正文\n'
    const state = EditorState.create({ doc: '' })
    const next = state.update({
      changes: { from: 0, to: 0, insert: propsValue },
      selection: { anchor: propsValue.length },
    })
    expect(next.state.doc.length).toBe(propsValue.length)
  })
})
