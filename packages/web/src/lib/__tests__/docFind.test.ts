import { describe, test, expect } from 'bun:test'
import { findMatchRanges, stepFindIndex } from '../docFind'

describe('findMatchRanges', () => {
  test('空查询无命中', () => {
    expect(findMatchRanges('hello world', '')).toEqual([])
    expect(findMatchRanges('hello world', '   ')).toEqual([])
  })

  test('大小写不敏感、可重叠步进', () => {
    expect(findMatchRanges('Ababa', 'aba')).toEqual([
      { start: 0, end: 3 },
      { start: 2, end: 5 },
    ])
  })

  test('中文子串', () => {
    expect(findMatchRanges('阅读这篇笔记', '这篇')).toEqual([{ start: 2, end: 4 }])
  })
})

describe('stepFindIndex', () => {
  test('无命中保持 -1', () => {
    expect(stepFindIndex(-1, 0, 1)).toBe(-1)
  })

  test('下一个循环', () => {
    expect(stepFindIndex(2, 3, 1)).toBe(0)
    expect(stepFindIndex(-1, 3, 1)).toBe(0)
  })

  test('上一个循环', () => {
    expect(stepFindIndex(0, 3, -1)).toBe(2)
    expect(stepFindIndex(-1, 3, -1)).toBe(2)
  })
})
