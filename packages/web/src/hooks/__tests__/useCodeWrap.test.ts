import { describe, test, expect, beforeEach } from 'bun:test'

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

describe('readCodeWrap / writeCodeWrap', () => {
  test('默认不折行', async () => {
    const { readCodeWrap } = await import('../useCodeWrap')
    expect(readCodeWrap()).toBe(false)
  })

  test('写入后读回', async () => {
    const { readCodeWrap, writeCodeWrap } = await import('../useCodeWrap')
    writeCodeWrap(true)
    expect(memStore.getItem('nf_code_wrap')).toBe('1')
    expect(readCodeWrap()).toBe(true)
    writeCodeWrap(false)
    expect(readCodeWrap()).toBe(false)
  })
})
