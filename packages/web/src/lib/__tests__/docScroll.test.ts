/**
 * 阅读位置记忆契约。
 *
 * 这组用例盯的是三类容易静默出错的场景（lector readingPosition.ts 的同一批教训）：
 *  1. 会话状态无限增长（只写不淘汰）；
 *  2. 文档被大幅改短后按旧偏移恢复，跳到别处；
 *  3. 回到顶部仍留旧记录，下次打开莫名跳回中间。
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  DOC_SCROLLS_KEY,
  MIN_RECORDED_TOP,
  docScrollTop,
  flushDocScrollWrite,
  parseDocScrolls,
  pruneDocScrolls,
  readDocScrollTop,
  recordDocScroll,
  scheduleDocScrollWrite,
  type DocScrollMap,
} from '../docScroll'

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

describe('阅读位置记录（纯函数）', () => {
  test('按 docId 隔离，记录 top / len / at', () => {
    const map = recordDocScroll(recordDocScroll({}, 'a', 120, 4000, 111), 'b', 300, 9000, 222)
    expect(map.a).toEqual({ top: 120, len: 4000, at: 111 })
    expect(map.b).toEqual({ top: 300, len: 9000, at: 222 })
  })

  test('不修改入参', () => {
    const map: DocScrollMap = {}
    recordDocScroll(map, 'a', 120, 4000)
    expect(map).toEqual({})
  })

  test('回到顶部 = 放弃记录（删掉旧值，而不是记一条 0）', () => {
    const withRec = recordDocScroll({}, 'a', 120, 4000)
    const cleared = recordDocScroll(withRec, 'a', MIN_RECORDED_TOP - 1, 4000)
    expect(cleared).toEqual({})
    expect(docScrollTop(cleared, 'a', 4000)).toBeNull()
  })

  test('非有限数字与空 id 不入库', () => {
    expect(recordDocScroll({}, 'a', Number.NaN, 4000)).toEqual({})
    expect(recordDocScroll({}, '  ', 100, 4000)).toEqual({})
  })

  test('文档被改短一半以上时旧位置失效', () => {
    const map = recordDocScroll({}, 'a', 3000, 9000)
    expect(docScrollTop(map, 'a', 9000)).toBe(3000)
    expect(docScrollTop(map, 'a', 4500)).toBe(3000) // 正好一半仍可用
    expect(docScrollTop(map, 'a', 4400)).toBeNull() // 不足一半 → 不恢复
  })

  test('无记录返回 null', () => {
    expect(docScrollTop({}, 'missing', 1000)).toBeNull()
  })

  test('淘汰最久未读的，保留最近 MAX 条', () => {
    let map: DocScrollMap = {}
    for (let i = 0; i < 70; i++) map = recordDocScroll(map, `doc${i}`, 100 + i, 5000, i)
    const pruned = pruneDocScrolls(map)
    expect(Object.keys(pruned).length).toBe(60)
    expect(pruned.doc69).toBeDefined()
    expect(pruned.doc9).toBeUndefined()
  })

  test('坏数据当空，逐字段校验', () => {
    expect(parseDocScrolls(null)).toEqual({})
    expect(parseDocScrolls('not json')).toEqual({})
    expect(parseDocScrolls('[1,2]')).toEqual({})
    expect(parseDocScrolls('{"a":{"top":"x"},"b":{"top":12}}')).toEqual({
      b: { top: 12, len: 0, at: 0 },
    })
  })
})

describe('阅读位置落盘（防抖）', () => {
  test('调度后立即读不到，flush 之后才可见——且跨「会话」仍在（localStorage）', () => {
    scheduleDocScrollWrite('doc-a', 800, 6000)
    expect(readDocScrollTop('doc-a', 6000)).toBeNull()
    flushDocScrollWrite()
    expect(readDocScrollTop('doc-a', 6000)).toBe(800)
    expect(localStorage.getItem(DOC_SCROLLS_KEY)).toContain('doc-a')
  })

  test('同一篇只留最后一次位置，flush 后无悬挂写', () => {
    scheduleDocScrollWrite('doc-a', 500, 6000)
    scheduleDocScrollWrite('doc-a', 900, 6000)
    flushDocScrollWrite()
    expect(readDocScrollTop('doc-a', 6000)).toBe(900)
    // 第二次 flush 不应把位置写回旧值
    flushDocScrollWrite()
    expect(readDocScrollTop('doc-a', 6000)).toBe(900)
  })

  test('读到顶部后 flush 会清掉旧位置', () => {
    scheduleDocScrollWrite('doc-a', 900, 6000)
    flushDocScrollWrite()
    scheduleDocScrollWrite('doc-a', 0, 6000)
    flushDocScrollWrite()
    expect(readDocScrollTop('doc-a', 6000)).toBeNull()
  })
})
