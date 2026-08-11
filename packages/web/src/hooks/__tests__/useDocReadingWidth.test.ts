import { describe, test, expect, beforeEach } from 'bun:test'

/**
 * useDocReadingWidth 走 localStorage（nf_doc_reading_width）。
 * bun:test 在 node env 下没 DOM——polyfill localStorage / window（同 useDocRailWidth.test）。
 */

class MemoryStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.get(k) ?? null }
  setItem(k: string, v: string): void { this.store.set(k, v) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
  key(i: number): string | null { return [...this.store.keys()][i] ?? null }
  get length(): number { return this.store.size }
}

const memStore = new MemoryStorage()

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: memStore, dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} },
    writable: true,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    value: memStore,
    writable: true,
    configurable: true,
  })
  memStore.clear()
})

describe('readDocReadingWidth / writeDocReadingWidth', () => {
  test('默认 normal（无 localStorage 值）', async () => {
    const { readDocReadingWidth } = await import('../useDocReadingWidth')
    expect(readDocReadingWidth()).toBe('normal')
  })

  test('写入 wide 后读回 wide', async () => {
    const { readDocReadingWidth, writeDocReadingWidth } = await import('../useDocReadingWidth')
    writeDocReadingWidth('wide')
    expect(memStore.getItem('nf_doc_reading_width')).toBe('wide')
    expect(readDocReadingWidth()).toBe('wide')
  })

  test('写入 normal 后读回 normal', async () => {
    const { readDocReadingWidth, writeDocReadingWidth } = await import('../useDocReadingWidth')
    writeDocReadingWidth('wide')
    writeDocReadingWidth('normal')
    expect(readDocReadingWidth()).toBe('normal')
  })

  test('localStorage 有未知值时回退 normal', async () => {
    memStore.setItem('nf_doc_reading_width', 'garbage')
    const { readDocReadingWidth } = await import('../useDocReadingWidth')
    expect(readDocReadingWidth()).toBe('normal')
  })
})

describe('DOC_READING_WIDTH_REM', () => {
  test('normal=46rem（最佳行宽）/ wide=64rem（图表友好，外层 max-w-6xl 容纳）', async () => {
    const { DOC_READING_WIDTH_REM } = await import('../useDocReadingWidth')
    expect(DOC_READING_WIDTH_REM.normal).toBe(46)
    expect(DOC_READING_WIDTH_REM.wide).toBe(64)
  })
})
