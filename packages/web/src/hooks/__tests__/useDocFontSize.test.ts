import { describe, test, expect, beforeEach } from 'bun:test'

/**
 * useDocFontSize 走 module-level state（current）+ localStorage。
 * bun:test 在 node env 下没 DOM——polyfill localStorage / window。
 * module 状态隔离：每个 test 用 `import` 取缓存副本，靠测试顺序控制 current
 * 起点（beforeEach 显式 resetDocFontSize）。
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

beforeEach(async () => {
  // Node 22+ 上 globalThis.window 是只读 getter，直接赋值抛 TypeError。
  // 用 defineProperty 强制覆盖（configurable: true 允许后续重设）
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: memStore },
    writable: true,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    value: memStore,
    writable: true,
    configurable: true,
  })
  memStore.clear()
  // module-level current 跨测试持续——强制重置为 md，避免上一个测试把 xl 带进下一个
  const { resetDocFontSize } = await import('../useDocFontSize')
  resetDocFontSize()
})

describe('SIZES / SIZE_ORDER（纯数据）', () => {
  test('SIZE_ORDER 固定 4 档 sm < md < lg < xl', async () => {
    const { SIZES, SIZE_ORDER } = await import('../useDocFontSize')
    expect(SIZE_ORDER).toEqual(['sm', 'md', 'lg', 'xl'])
    const px = SIZE_ORDER.map((s) => SIZES[s].px)
    for (let i = 1; i < px.length; i++) {
      expect(px[i]).toBeGreaterThan(px[i - 1]!)
    }
  })

  test('默认 md = 16px；整档 14 / 16 / 19 / 22（demo 舒服梯度）', async () => {
    const { SIZES } = await import('../useDocFontSize')
    expect(SIZES.sm.px).toBe(14)
    expect(SIZES.md.px).toBe(16)
    expect(SIZES.lg.px).toBe(19)
    expect(SIZES.xl.px).toBe(22)
  })

  test('每档 labelKey 都指向 doc.fontSize.*', async () => {
    const { SIZES } = await import('../useDocFontSize')
    for (const s of ['sm', 'md', 'lg', 'xl'] as const) {
      expect(SIZES[s].labelKey).toMatch(/^doc\.fontSize\./)
    }
  })
})

describe('setDocFontSize / cycle / reset', () => {
  test('setDocFontSize 写到 localStorage，reset 回到 md', async () => {
    const { setDocFontSize, resetDocFontSize } = await import('../useDocFontSize')
    setDocFontSize('lg')
    expect(memStore.getItem('notefast.docFontSize')).toBe('lg')
    resetDocFontSize()
    expect(memStore.getItem('notefast.docFontSize')).toBe('md')
  })

  test('cycle(1) 与 cycle(-1) 双向', async () => {
    const { cycleDocFontSize } = await import('../useDocFontSize')
    cycleDocFontSize(1) // md → lg
    expect(memStore.getItem('notefast.docFontSize')).toBe('lg')
    cycleDocFontSize(-1) // lg → md
    expect(memStore.getItem('notefast.docFontSize')).toBe('md')
    cycleDocFontSize(-1) // md → sm
    expect(memStore.getItem('notefast.docFontSize')).toBe('sm')
  })

  test('cycle 跨边界（xl→sm, sm→xl）', async () => {
    const { setDocFontSize, cycleDocFontSize } = await import('../useDocFontSize')
    setDocFontSize('xl')
    cycleDocFontSize(1) // xl → sm
    expect(memStore.getItem('notefast.docFontSize')).toBe('sm')
    setDocFontSize('sm')
    cycleDocFontSize(-1) // sm → xl
    expect(memStore.getItem('notefast.docFontSize')).toBe('xl')
  })

  test('连续 cycle 4 步回到起点', async () => {
    const { cycleDocFontSize } = await import('../useDocFontSize')
    cycleDocFontSize(1)
    cycleDocFontSize(1)
    cycleDocFontSize(1)
    cycleDocFontSize(1) // md → lg → xl → sm → md
    expect(memStore.getItem('notefast.docFontSize')).toBe('md')
  })
})