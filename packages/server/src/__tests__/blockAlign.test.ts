import { describe, expect, test } from 'bun:test'
import { fingerprintBlock, planBlockAlign } from '../services/blockAlign'

describe('planBlockAlign', () => {
  test('改一段：其余精确匹配，改动段按类型就地保留', () => {
    const oldFps = ['p\na\n{}', 'p\nb\n{}', 'p\nc\n{}']
    const newFps = ['p\na\n{}', 'p\nb2\n{}', 'p\nc\n{}']
    const types = ['paragraph', 'paragraph', 'paragraph']
    const ops = planBlockAlign(oldFps, newFps, types, types)
    expect(ops).toEqual([
      { kind: 'keep', oldIndex: 0, newIndex: 0, contentChanged: false },
      { kind: 'keep', oldIndex: 1, newIndex: 1, contentChanged: true },
      { kind: 'keep', oldIndex: 2, newIndex: 2, contentChanged: false },
    ])
  })

  test('中间插入：两侧 id 可保留', () => {
    const oldFps = ['p\na\n{}', 'p\nc\n{}']
    const newFps = ['p\na\n{}', 'p\nb\n{}', 'p\nc\n{}']
    const oldT = ['paragraph', 'paragraph']
    const newT = ['paragraph', 'paragraph', 'paragraph']
    const ops = planBlockAlign(oldFps, newFps, oldT, newT)
    expect(ops.map((o) => o.kind)).toEqual(['keep', 'insert', 'keep'])
    expect(ops[0]).toMatchObject({ oldIndex: 0, newIndex: 0 })
    expect(ops[1]).toMatchObject({ newIndex: 1 })
    expect(ops[2]).toMatchObject({ oldIndex: 1, newIndex: 2 })
  })

  test('删除一段', () => {
    const oldFps = ['p\na\n{}', 'p\nb\n{}', 'p\nc\n{}']
    const newFps = ['p\na\n{}', 'p\nc\n{}']
    const oldT = ['paragraph', 'paragraph', 'paragraph']
    const newT = ['paragraph', 'paragraph']
    const ops = planBlockAlign(oldFps, newFps, oldT, newT)
    expect(ops.map((o) => o.kind)).toEqual(['keep', 'delete', 'keep'])
  })

  test('类型不同的空隙不会误当成就地编辑', () => {
    const oldFps = ['p\na\n{}']
    const newFps = ['heading\na\n{"headingLevel":1}']
    const ops = planBlockAlign(oldFps, newFps, ['paragraph'], ['heading'])
    expect(ops.map((o) => o.kind)).toEqual(['delete', 'insert'])
  })
})

describe('fingerprintBlock', () => {
  test('属性参与指纹', () => {
    expect(fingerprintBlock('heading', 'Hi', '{"headingLevel":2}')).not.toBe(
      fingerprintBlock('heading', 'Hi', '{"headingLevel":3}'),
    )
  })
})
