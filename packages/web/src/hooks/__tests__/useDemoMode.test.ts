import { describe, test, expect, beforeEach } from 'bun:test'

/**
 * useDemoMode 是纯内存 store（不持久化——演示是临时场景，需要时自己开）。
 * 用 getDemoState() 非 hook 读取（bun:test 无 React 渲染环境）。
 * 每个 test 重置模块态：beforeEach 显式 resetDemoZoom。
 */

beforeEach(async () => {
  const { resetDemoZoom } = await import('../useDemoMode')
  resetDemoZoom()
})

describe('DEMO_ZOOMS（纯数据）', () => {
  test('放大档位 125/150/175/200（上限 200%，投影够用）', async () => {
    const { DEMO_ZOOMS } = await import('../useDemoMode')
    expect(DEMO_ZOOMS).toEqual([1.25, 1.5, 1.75, 2])
  })
})

describe('进入/退出/开关', () => {
  test('初始非激活；enterDemoMode 后激活，默认档 1.5', async () => {
    const { getDemoState, enterDemoMode } = await import('../useDemoMode')
    expect(getDemoState().active).toBe(false)
    enterDemoMode()
    expect(getDemoState().active).toBe(true)
    expect(getDemoState().zoomIndex).toBe(1) // DEMO_ZOOMS[1] = 1.5
  })

  test('exitDemoMode 退出；toggleDemoMode 翻转', async () => {
    const { getDemoState, enterDemoMode, exitDemoMode, toggleDemoMode } = await import('../useDemoMode')
    enterDemoMode()
    exitDemoMode()
    expect(getDemoState().active).toBe(false)
    toggleDemoMode()
    expect(getDemoState().active).toBe(true)
    toggleDemoMode()
    expect(getDemoState().active).toBe(false)
  })

  test('退出后不丢档位；再次进入沿用上次档位', async () => {
    const { getDemoState, enterDemoMode, exitDemoMode, setDemoZoomIndex } = await import('../useDemoMode')
    enterDemoMode()
    setDemoZoomIndex(3) // 200%
    exitDemoMode()
    enterDemoMode()
    expect(getDemoState().zoomIndex).toBe(3)
  })
})

describe('cycleDemoZoom', () => {
  test('未激活时 cycle 自动进入并跳到相邻档', async () => {
    const { getDemoState, cycleDemoZoom } = await import('../useDemoMode')
    const next = cycleDemoZoom(1) // 默认 1.5(1) → 1.75(2)
    expect(getDemoState().active).toBe(true)
    expect(next).toBe(1.75)
  })

  test('跨边界循环（200% → 125%）', async () => {
    const { setDemoZoomIndex, cycleDemoZoom } = await import('../useDemoMode')
    setDemoZoomIndex(3)
    expect(cycleDemoZoom(1)).toBe(1.25)
  })

  test('反向循环（125% → 200%）', async () => {
    const { setDemoZoomIndex, cycleDemoZoom } = await import('../useDemoMode')
    setDemoZoomIndex(0)
    expect(cycleDemoZoom(-1)).toBe(2)
  })
})

describe('resetDemoZoom / setDemoZoomIndex', () => {
  test('reset 退出演示模式并回默认档', async () => {
    const { getDemoState, enterDemoMode, setDemoZoomIndex, resetDemoZoom } = await import('../useDemoMode')
    enterDemoMode()
    setDemoZoomIndex(2)
    resetDemoZoom()
    expect(getDemoState().active).toBe(false)
    expect(getDemoState().zoomIndex).toBe(1) // 默认档 1.5
  })

  test('setDemoZoomIndex 越界 clamp', async () => {
    const { getDemoState, setDemoZoomIndex } = await import('../useDemoMode')
    setDemoZoomIndex(99)
    expect(getDemoState().zoomIndex).toBe(3)
    setDemoZoomIndex(-5)
    expect(getDemoState().zoomIndex).toBe(0)
  })
})
