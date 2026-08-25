import { describe, test, expect } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { fenceInfoCompletion } from '../fenceInfoCompletion'

function complete(doc: string, pos: number, explicit = true) {
  const state = EditorState.create({ doc })
  return fenceInfoCompletion(new CompletionContext(state, pos, explicit))
}

describe('fenceInfoCompletion', () => {
  test('开围栏 info string 给出语言选项', () => {
    const result = complete('```', 3)
    expect(result).not.toBeNull()
    expect(result!.from).toBe(3)
    expect(result!.options.some((o) => o.label === 'js')).toBe(true)
    expect(result!.options.some((o) => o.label === 'mermaid')).toBe(true)
    expect(result!.options.some((o) => o.label === 'math')).toBe(true)
  })

  test('已输入前缀时替换整个 info', () => {
    const result = complete('```js', 5)
    expect(result?.from).toBe(3)
    expect(result?.to).toBe(5)
  })

  test('~~~ 开围栏同样补全', () => {
    const result = complete('~~~py', 5)
    expect(result?.from).toBe(3)
    expect(result?.options.some((o) => o.label === 'python')).toBe(true)
  })

  test('围栏内部不补全', () => {
    expect(complete('```js\nconst x = 1\n```', 10)).toBeNull()
  })

  test('闭围栏不补全', () => {
    const doc = '```\nhi\n```'
    expect(complete(doc, doc.length)).toBeNull()
  })

  test('普通段落不补全', () => {
    expect(complete('hello js', 8)).toBeNull()
  })
})
