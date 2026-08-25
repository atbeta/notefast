import { describe, expect, test } from 'bun:test'
import { openDocChangeAction } from '../openDocChange'

describe('openDocChangeAction', () => {
  test('其它文档忽略', () => {
    expect(openDocChangeAction({ doc_id: 'b', kind: 'updated' }, 'a', false)).toBe('ignore')
  })

  test('未打开文档忽略', () => {
    expect(openDocChangeAction({ doc_id: 'a', kind: 'updated' }, undefined, false)).toBe('ignore')
  })

  test('阅读态对本篇 updated/created 立即刷新', () => {
    expect(openDocChangeAction({ doc_id: 'a', kind: 'updated' }, 'a', false)).toBe('reload')
    expect(openDocChangeAction({ doc_id: 'a', kind: 'created' }, 'a', false)).toBe('reload')
  })

  test('编辑态对本篇写入推迟到退出编辑', () => {
    expect(openDocChangeAction({ doc_id: 'a', kind: 'updated' }, 'a', true)).toBe('defer')
  })

  test('本篇删除无论是否编辑都离开', () => {
    expect(openDocChangeAction({ doc_id: 'a', kind: 'deleted' }, 'a', false)).toBe('gone')
    expect(openDocChangeAction({ doc_id: 'a', kind: 'deleted' }, 'a', true)).toBe('gone')
  })
})
