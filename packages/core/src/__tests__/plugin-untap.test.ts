import { describe, test, expect } from 'bun:test'
import { SyncHook, AsyncParallelHook, SyncBailHook } from '../plugin'

describe('SyncHook untap', () => {
  test('untap 移除指定 name 的所有 tap', () => {
    const h = new SyncHook<[number]>()
    const calls: number[] = []
    h.tap('a', (n) => { calls.push(n * 1) })
    h.tap('a', (n) => { calls.push(n * 2) })
    h.tap('b', (n) => { calls.push(n * 10) })
    h.untap('a')
    h.call(1)
    expect(calls).toEqual([10])
  })

  test('untap 不存在的 name 不报错', () => {
    const h = new SyncHook()
    expect(() => h.untap('nope')).not.toThrow()
  })
})

describe('AsyncParallelHook untap', () => {
  test('untap 后 tap 不再触发', async () => {
    const h = new AsyncParallelHook<[number]>()
    const calls: number[] = []
    h.tap('x', async (n) => { calls.push(n) })
    h.untap('x')
    await h.call(1)
    expect(calls).toEqual([])
  })
})

describe('SyncBailHook untap', () => {
  test('untap 后 bail 不再生效', () => {
    const h = new SyncBailHook<[number], string>()
    h.tap('b', () => 'blocked')
    h.tap('c', () => 'passed')
    expect(h.call(1)).toBe('blocked')
    h.untap('b')
    expect(h.call(1)).toBe('passed')
  })
})