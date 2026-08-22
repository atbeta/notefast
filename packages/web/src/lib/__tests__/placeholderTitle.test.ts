import { describe, test, expect } from 'bun:test'
import { isPlaceholderDocTitle } from '../time'

describe('isPlaceholderDocTitle', () => {
  test('空标题与「无标题文档」视为占位', () => {
    expect(isPlaceholderDocTitle('', '无标题文档')).toBe(true)
    expect(isPlaceholderDocTitle('无标题文档', '无标题文档')).toBe(true)
    expect(isPlaceholderDocTitle('Untitled', 'Untitled')).toBe(true)
  })

  test('中英日期短标题视为占位', () => {
    expect(isPlaceholderDocTitle('8月23日', '无标题文档')).toBe(true)
    expect(isPlaceholderDocTitle('Aug 23', 'Untitled')).toBe(true)
    expect(isPlaceholderDocTitle('August 23, 2026', 'Untitled')).toBe(true)
  })

  test('正经标题不覆盖', () => {
    expect(isPlaceholderDocTitle('项目纪要', '无标题文档')).toBe(false)
    expect(isPlaceholderDocTitle('Meeting notes', 'Untitled')).toBe(false)
  })
})
