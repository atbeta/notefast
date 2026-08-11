import { describe, test, expect, beforeEach } from 'bun:test'

/**
 * useDocRailWidth 走 localStorage（nf_doc_rail_width）。
 * bun:test 在 node env 下没 DOM——polyfill localStorage / window。
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
  // Node 22+ 上 globalThis.window 是只读 getter，直接赋值抛 TypeError。
  // 用 defineProperty 强制覆盖（configurable: true 允许后续重设）
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

describe('readDocRailWidth / writeDocRailWidth', () => {
  test('默认 normal（无 localStorage 值）', async () => {
    const { readDocRailWidth } = await import('../useDocRailWidth')
    expect(readDocRailWidth()).toBe('normal')
  })

  test('写入 wide 后读回 wide', async () => {
    const { readDocRailWidth, writeDocRailWidth } = await import('../useDocRailWidth')
    writeDocRailWidth('wide')
    expect(memStore.getItem('nf_doc_rail_width')).toBe('wide')
    expect(readDocRailWidth()).toBe('wide')
  })

  test('写入 normal 后读回 normal', async () => {
    const { readDocRailWidth, writeDocRailWidth } = await import('../useDocRailWidth')
    writeDocRailWidth('wide')
    writeDocRailWidth('normal')
    expect(readDocRailWidth()).toBe('normal')
  })

  test('localStorage 有未知值时回退 normal', async () => {
    memStore.setItem('nf_doc_rail_width', 'garbage')
    const { readDocRailWidth } = await import('../useDocRailWidth')
    expect(readDocRailWidth()).toBe('normal')
  })
})

describe('DOC_RAIL_WIDTH_PX', () => {
  test('normal=400 / wide=600，与 AI 聊天窗两档对齐', async () => {
    const { DOC_RAIL_WIDTH_PX } = await import('../useDocRailWidth')
    expect(DOC_RAIL_WIDTH_PX.normal).toBe(400)
    expect(DOC_RAIL_WIDTH_PX.wide).toBe(600)
  })
})
