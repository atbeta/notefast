import { describe, test, expect } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { buildReplaceRangeUpdate } from '../refineReplace'
import { RefineSession } from '../../refineSession'

describe('buildReplaceRangeUpdate（改写流式渐进替换）', () => {
  test('首个 token 替换原选区，后续 token 替换已插入文本', () => {
    let state = EditorState.create({ doc: 'hello world, this is fine' })
    // 原选区 [6, 20) = "world, this is"
    state = state.update({
      ...buildReplaceRangeUpdate(state.doc.length, 6, 20, 'w'),
      userEvent: 'input',
    }).state
    expect(state.doc.toString()).toBe('hello w fine')

    // 第二个累积快照：替换 [6, 6 + 已插入长度 1)
    state = state.update({
      ...buildReplaceRangeUpdate(state.doc.length, 6, 6 + 1, 'wonderful'),
      userEvent: 'input',
    }).state
    expect(state.doc.toString()).toBe('hello wonderful fine')
    // 光标落在插入文本末尾
    expect(state.selection.main.anchor).toBe(6 + 'wonderful'.length)
  })

  test('from/to 越界时 clamp 到文档范围', () => {
    const state = EditorState.create({ doc: 'abc' })
    const next = state.update(buildReplaceRangeUpdate(state.doc.length, 2, 99, 'Z')).state
    expect(next.doc.toString()).toBe('abZ')
  })
})

describe('RefineSession（外部编辑取消流）', () => {
  test('首个 apply 替换原选区 [from, to)，之后随已插入长度推进', () => {
    const calls: Array<[number, number, string]> = []
    // 原选区 [6, 20)
    const session = new RefineSession(6, 20, (from, to, text) => {
      calls.push([from, to, text])
    })
    session.apply('润')
    session.apply('润色')
    expect(calls).toEqual([
      [6, 20, '润'],
      [6, 7, '润色'],
    ])
  })

  test('端到端：原选区文本被删除，不留重复（钉住曾有的纯插入 bug）', () => {
    let state = EditorState.create({ doc: 'hello world, this is fine' })
    // 选区 [6, 20) = "world, this is"
    const session = new RefineSession(6, 20, (from, to, text) => {
      state = state.update({
        ...buildReplaceRangeUpdate(state.doc.length, from, to, text),
        userEvent: 'input',
      }).state
    })
    session.apply('w')
    expect(state.doc.toString()).toBe('hello w fine')
    session.apply('wonderful')
    expect(state.doc.toString()).toBe('hello wonderful fine')
  })

  test('apply 内的变更不算外部编辑；token 间隙的变更算外部编辑（应取消流）', () => {
    // 模拟 dispatch 同步触发 onChange：记录 apply 期间的判定结果
    const duringApply: boolean[] = []
    const session = new RefineSession(0, 5, () => {
      duringApply.push(session.isExternalEdit())
    })
    session.apply('改写文本')
    expect(duringApply).toEqual([false])
    // 流式空闲期（下一次 token 前）的用户输入 = 外部编辑 → 调用方应取消流
    expect(session.isExternalEdit()).toBe(true)
  })
})
