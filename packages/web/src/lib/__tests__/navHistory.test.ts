import { describe, expect, test, beforeEach } from 'bun:test'
import {
  applyNavLocation,
  navHistorySnapshot,
  setCurrentNavLabel,
  navKey,
  _resetNavHistoryForTests,
} from '../navHistory'

beforeEach(() => {
  _resetNavHistoryForTests()
})

describe('navHistory', () => {
  test('navKey 忽略 hash、包含 search', () => {
    expect(navKey({ pathname: '/doc/a', search: '?x=1' })).toBe('/doc/a?x=1')
  })

  test('首条播种后不能返回', () => {
    applyNavLocation({ pathname: '/', search: '' }, 'POP', '所有文档')
    const s = navHistorySnapshot()
    expect(s.canBack).toBe(false)
    expect(s.canForward).toBe(false)
    expect(s.current?.label).toBe('所有文档')
  })

  test('PUSH 进文档后可返回，标题回填当前条', () => {
    applyNavLocation({ pathname: '/', search: '' }, 'POP', '所有文档')
    applyNavLocation({ pathname: '/doc/a', search: '' }, 'PUSH', '无标题文档')
    setCurrentNavLabel('会议纪要')
    const s = navHistorySnapshot()
    expect(s.canBack).toBe(true)
    expect(s.back?.label).toBe('所有文档')
    expect(s.current?.label).toBe('会议纪要')
  })

  test('再 PUSH 后截断前进栈', () => {
    applyNavLocation({ pathname: '/', search: '' }, 'POP', 'Home')
    applyNavLocation({ pathname: '/doc/a', search: '' }, 'PUSH', 'A')
    applyNavLocation({ pathname: '/doc/b', search: '' }, 'PUSH', 'B')
    applyNavLocation({ pathname: '/doc/a', search: '' }, 'POP', 'A')
    expect(navHistorySnapshot().canForward).toBe(true)
    applyNavLocation({ pathname: '/doc/c', search: '' }, 'PUSH', 'C')
    const s = navHistorySnapshot()
    expect(s.canForward).toBe(false)
    expect(s.back?.label).toBe('A')
    expect(s.current?.label).toBe('C')
  })

  test('POP 前进 / 后退在相邻条目间移动', () => {
    applyNavLocation({ pathname: '/', search: '' }, 'POP', 'Home')
    applyNavLocation({ pathname: '/doc/a', search: '' }, 'PUSH', 'A')
    applyNavLocation({ pathname: '/doc/b', search: '' }, 'PUSH', 'B')
    applyNavLocation({ pathname: '/doc/a', search: '' }, 'POP', 'A')
    expect(navHistorySnapshot().current?.pathname).toBe('/doc/a')
    expect(navHistorySnapshot().canForward).toBe(true)
    applyNavLocation({ pathname: '/doc/b', search: '' }, 'POP', 'B')
    expect(navHistorySnapshot().current?.pathname).toBe('/doc/b')
    expect(navHistorySnapshot().canForward).toBe(false)
  })

  test('REPLACE 改当前不增加条目', () => {
    applyNavLocation({ pathname: '/', search: '' }, 'POP', 'Home')
    applyNavLocation({ pathname: '/', search: '?tag=x' }, 'REPLACE', 'Home')
    const s = navHistorySnapshot()
    expect(s.canBack).toBe(false)
    expect(s.current?.search).toBe('?tag=x')
  })

  test('相同 PUSH 不重复入栈（Strict Mode 重跑）', () => {
    applyNavLocation({ pathname: '/doc/a', search: '' }, 'PUSH', 'A')
    applyNavLocation({ pathname: '/doc/a', search: '' }, 'PUSH', 'A')
    expect(navHistorySnapshot().canBack).toBe(false)
  })
})
