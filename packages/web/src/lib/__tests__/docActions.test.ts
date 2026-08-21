import { describe, test, expect } from 'bun:test'
import { docActionIdsFor, isReadingDoc, resolveDocLifecycle } from '../docActions'

describe('resolveDocLifecycle', () => {
  test('doc.status 优先于 surface', () => {
    expect(resolveDocLifecycle('inbox', 'list')).toBe('inbox')
    expect(resolveDocLifecycle('archived', 'sidebar')).toBe('archived')
    expect(resolveDocLifecycle('note', 'inbox')).toBe('note')
  })

  test('缺 status 时用 surface 兜底', () => {
    expect(resolveDocLifecycle(undefined, 'archived')).toBe('archived')
    expect(resolveDocLifecycle(undefined, 'list')).toBe('note')
  })
})

describe('isReadingDoc', () => {
  test('正在打开该文档时为 true（含仅 pathname）', () => {
    expect(isReadingDoc('/doc/abc', 'abc')).toBe(true)
  })

  test('在别的文档或非文档页为 false', () => {
    expect(isReadingDoc('/doc/abc', 'xyz')).toBe(false)
    expect(isReadingDoc('/', 'abc')).toBe(false)
    expect(isReadingDoc('/inbox', 'abc')).toBe(false)
  })
})

describe('docActionIdsFor', () => {
  test('收集箱：加入笔记 + 丢弃，不含归档/分享/AI', () => {
    expect(docActionIdsFor('inbox')).toEqual(['open-tab', 'rename', 'promote', 'delete'])
  })

  test('归档：恢复 + 导出，不含归档/分享/AI', () => {
    expect(docActionIdsFor('archived')).toEqual(['open-tab', 'rename', 'restore', 'export', 'delete'])
  })

  test('笔记：归档/分享/导出/AI/删除', () => {
    expect(docActionIdsFor('note')).toEqual([
      'open-tab',
      'rename',
      'archive',
      'share',
      'export',
      'ai-exclude',
      'delete',
    ])
  })
})
