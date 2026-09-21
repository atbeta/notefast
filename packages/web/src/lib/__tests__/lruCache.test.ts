import { describe, test, expect } from 'bun:test'
import { createLruCache } from '../lruCache'

describe('createLruCache', () => {
  test('读写与未命中', () => {
    const c = createLruCache<string, number>(3)
    expect(c.get('a')).toBeNull()
    c.set('a', 1)
    expect(c.get('a')).toBe(1)
    expect(c.size).toBe(1)
  })

  test('命中会刷新新鲜度（否则退化成 FIFO）', () => {
    const c = createLruCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.get('a') // a 变成最新
    c.set('c', 3) // 应淘汰 b 而不是 a
    expect(c.keys()).toEqual(['a', 'c'])
    expect(c.get('a')).toBe(1)
    expect(c.get('b')).toBeNull()
  })

  test('超出上限丢最久未用的', () => {
    const c = createLruCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    expect(c.keys()).toEqual(['b', 'c'])
    expect(c.size).toBe(2)
  })

  test('覆盖同一个键不增加条目，且视为最新', () => {
    const c = createLruCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('a', 9)
    c.set('c', 3) // 淘汰 b
    expect(c.get('a')).toBe(9)
    expect(c.get('b')).toBeNull()
    expect(c.size).toBe(2)
  })

  test('上限非法时至少保留 1 条', () => {
    const c = createLruCache<string, number>(0)
    c.set('a', 1)
    expect(c.size).toBe(1)
    c.set('b', 2)
    expect(c.keys()).toEqual(['b'])
  })

  test('delete / clear 生效', () => {
    const c = createLruCache<string, number>(5)
    c.set('a', 1)
    c.set('b', 2)
    c.delete('a')
    expect(c.keys()).toEqual(['b'])
    c.clear()
    expect(c.size).toBe(0)
  })
})
