import { describe, test, expect, beforeEach } from 'bun:test'
import { readDocScroll, writeDocScroll, DOC_SCROLL_KEY_PREFIX } from '../docScroll'

function installMemorySessionStorage() {
  const store = new Map<string, string>()
  const ss = {
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
  Object.defineProperty(globalThis, 'sessionStorage', { value: ss, configurable: true })
}

installMemorySessionStorage()

beforeEach(() => {
  sessionStorage.clear()
})

describe('docScroll', () => {
  test('未记录返回 null', () => {
    expect(readDocScroll('abc')).toBeNull()
  })

  test('读写按 docId 隔离', () => {
    writeDocScroll('a', 120)
    writeDocScroll('b', 40)
    expect(readDocScroll('a')).toBe(120)
    expect(readDocScroll('b')).toBe(40)
    expect(sessionStorage.getItem(`${DOC_SCROLL_KEY_PREFIX}a`)).toBe('120')
  })

  test('忽略非有限数字', () => {
    writeDocScroll('a', Number.NaN)
    expect(readDocScroll('a')).toBeNull()
    writeDocScroll('', 10)
    expect(readDocScroll('')).toBeNull()
  })
})
