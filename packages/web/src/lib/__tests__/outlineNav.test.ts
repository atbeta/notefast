import { describe, test, expect } from 'bun:test'
import { ancestorHeadingIds, type OutlineEntry } from '../outlineNav'

const h = (id: string, depth: number): OutlineEntry => ({ id, depth })

describe('ancestorHeadingIds', () => {
  const outline = [
    h('h1', 0),
    h('h2a', 1),
    h('h3a', 2),
    h('h3b', 2),
    h('h2b', 1),
  ]

  test('h3 的祖先链是本文档序里 depth 严格递减的那些', () => {
    expect(ancestorHeadingIds(outline, 'h3b')).toEqual(['h2a', 'h1'])
  })

  test('h2 的祖先是上级标题', () => {
    expect(ancestorHeadingIds(outline, 'h2b')).toEqual(['h1'])
  })

  test('第一个标题没有祖先', () => {
    expect(ancestorHeadingIds(outline, 'h1')).toEqual([])
  })

  test('同级标题之间互不为祖先', () => {
    expect(ancestorHeadingIds(outline, 'h3a')).toEqual(['h2a', 'h1'])
  })

  test('跳级（h1 → h3）也能正确串起来', () => {
    expect(ancestorHeadingIds([h('a', 0), h('b', 2)], 'b')).toEqual(['a'])
  })

  test('活跃项不在列表里 / 为 null 时返回空', () => {
    expect(ancestorHeadingIds(outline, 'missing')).toEqual([])
    expect(ancestorHeadingIds(outline, null)).toEqual([])
    expect(ancestorHeadingIds([], 'h1')).toEqual([])
  })
})
