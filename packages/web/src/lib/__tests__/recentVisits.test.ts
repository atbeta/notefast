import { describe, test, expect, beforeEach } from 'bun:test'
import {
  getRecentVisitIds,
  recordVisit,
  removeVisit,
  pruneVisitsNotIn,
  orderDocsByVisits,
  RECENT_VISITS_MAX,
} from '../recentVisits'

const KEY = 'notefast.recentVisits'

/** bun test 无 DOM localStorage；用内存 Map 模拟 */
function installMemoryLocalStorage() {
  const store = new Map<string, string>()
  const ls = {
    getItem(k: string) {
      return store.has(k) ? store.get(k)! : null
    },
    setItem(k: string, v: string) {
      store.set(k, String(v))
    },
    removeItem(k: string) {
      store.delete(k)
    },
    clear() {
      store.clear()
    },
    key(i: number) {
      return [...store.keys()][i] ?? null
    },
    get length() {
      return store.size
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
}

installMemoryLocalStorage()

beforeEach(() => {
  localStorage.clear()
})

describe('recentVisits', () => {
  test('recordVisit 置顶并去重', () => {
    recordVisit('a')
    recordVisit('b')
    recordVisit('a')
    expect(getRecentVisitIds()).toEqual(['a', 'b'])
  })

  test('超过上限截断', () => {
    for (let i = 0; i < RECENT_VISITS_MAX + 5; i++) recordVisit(`d${i}`)
    const ids = getRecentVisitIds()
    expect(ids).toHaveLength(RECENT_VISITS_MAX)
    expect(ids[0]).toBe(`d${RECENT_VISITS_MAX + 4}`)
    expect(ids).not.toContain('d0')
  })

  test('removeVisit 摘掉指定 id', () => {
    recordVisit('a')
    recordVisit('b')
    removeVisit('a')
    expect(getRecentVisitIds()).toEqual(['b'])
  })

  test('pruneVisitsNotIn 清掉不在集合中的 id', () => {
    recordVisit('a')
    recordVisit('b')
    recordVisit('c')
    const changed = pruneVisitsNotIn(new Set(['a', 'c']))
    expect(changed).toBe(true)
    expect(getRecentVisitIds()).toEqual(['c', 'a'])
  })

  test('orderDocsByVisits 按足迹序，缺席的跳过', () => {
    const docs = [
      { id: 'x', title: 'X' },
      { id: 'y', title: 'Y' },
      { id: 'z', title: 'Z' },
    ]
    expect(orderDocsByVisits(docs, ['z', 'missing', 'x']).map((d) => d.id)).toEqual(['z', 'x'])
  })

  test('损坏的 localStorage 回退为空', () => {
    localStorage.setItem(KEY, '{not-json')
    expect(getRecentVisitIds()).toEqual([])
    localStorage.setItem(KEY, JSON.stringify([1, 'ok', null]))
    expect(getRecentVisitIds()).toEqual(['ok'])
  })
})
