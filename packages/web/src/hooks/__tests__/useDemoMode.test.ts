import { describe, test, expect, beforeEach } from 'bun:test'

/**
 * useDemoMode：缩放（zoom）与演示开关（active）解耦。
 * - zoom 独立生效：阅读模式即可调，不依赖 active
 * - active 只控制 UI 隐藏（侧栏/窗口标题栏/rail）
 * 用 getDemoState() 非 hook 读取（bun:test 无 React 渲染环境）。
 * 每个 test 重置模块态：beforeEach 显式 resetDemoZoom。
 */

beforeEach(async () => {
  const { resetDemoZoom } = await import('../useDemoMode')
  resetDemoZoom()
})

describe('DEMO_ZOOMS（纯数据）', () => {
  test('缩放档位 100/125/150/175/200（100% = 阅读默认；上限 200%）', async () => {
    const { DEMO_ZOOMS } = await import('../useDemoMode')
    expect(DEMO_ZOOMS).toEqual([1, 1.25, 1.5, 1.75, 2])
  })
})

describe('缩放独立于演示开关（阅读模式可调）', () => {
  test('setDemoZoomIndex 不改 active（未进入演示也能放大阅读）', async () => {
    const { getDemoState, setDemoZoomIndex } = await import('../useDemoMode')
    expect(getDemoState().active).toBe(false)
    setDemoZoomIndex(2) // 150%
    expect(getDemoState().zoomIndex).toBe(2)
    expect(getDemoState().active).toBe(false)
  })

  test('cycleDemoZoom 不改 active；未激活时也能循环', async () => {
    const { getDemoState, cycleDemoZoom } = await import('../useDemoMode')
    const next = cycleDemoZoom(1) // 100%(0) → 125%(1)
    expect(next).toBe(1.25)
    expect(getDemoState().active).toBe(false)
    expect(getDemoState().zoomIndex).toBe(1)
  })

  test('useDemoZoom 语义：非激活也返回当前档（DemoModeApplier 常写 CSS 变量）', async () => {
    const { setDemoZoomIndex } = await import('../useDemoMode')
    setDemoZoomIndex(3)
    // useDemoZoom 是 hook，这里直接验证 DEMO_ZOOMS 对应关系
    const { DEMO_ZOOMS } = await import('../useDemoMode')
    const { getDemoState } = await import('../useDemoMode')
    expect(DEMO_ZOOMS[getDemoState().zoomIndex]).toBe(1.75)
  })
})

describe('演示开关（active）', () => {
  test('初始非激活 100%；enterDemoMode 激活并跳到 150%（默认演示档）', async () => {
    const { getDemoState, enterDemoMode } = await import('../useDemoMode')
    expect(getDemoState().active).toBe(false)
    expect(getDemoState().zoomIndex).toBe(0)
    enterDemoMode()
    expect(getDemoState().active).toBe(true)
    expect(getDemoState().zoomIndex).toBe(2) // DEMO_ZOOMS[2] = 1.5
  })

  test('阅读已调档后 enterDemoMode 沿用当前档（不重置）', async () => {
    const { getDemoState, enterDemoMode, setDemoZoomIndex } = await import('../useDemoMode')
    setDemoZoomIndex(4) // 200%
    enterDemoMode()
    expect(getDemoState().active).toBe(true)
    expect(getDemoState().zoomIndex).toBe(4)
  })

  test('exitDemoMode 恢复进入前档位（100%→演示 150%→退出回 100%）', async () => {
    const { getDemoState, enterDemoMode, exitDemoMode } = await import('../useDemoMode')
    expect(getDemoState().zoomIndex).toBe(0)
    enterDemoMode()
    expect(getDemoState().zoomIndex).toBe(2)
    exitDemoMode()
    expect(getDemoState().active).toBe(false)
    expect(getDemoState().zoomIndex).toBe(0)
  })

  test('exitDemoMode 恢复进入前档位（即便演示中改过缩放）', async () => {
    const { getDemoState, enterDemoMode, exitDemoMode, setDemoZoomIndex } = await import('../useDemoMode')
    setDemoZoomIndex(1) // 阅读 125%
    enterDemoMode()
    expect(getDemoState().zoomIndex).toBe(1) // 非 100% 进入不跳档
    setDemoZoomIndex(4) // 演示中改到 200%
    exitDemoMode()
    expect(getDemoState().zoomIndex).toBe(1) // 回到进入前的 125%
  })

  test('toggleDemoMode 翻转并在退出时恢复档位', async () => {
    const { getDemoState, toggleDemoMode } = await import('../useDemoMode')
    toggleDemoMode()
    expect(getDemoState().active).toBe(true)
    expect(getDemoState().zoomIndex).toBe(2)
    toggleDemoMode()
    expect(getDemoState().active).toBe(false)
    expect(getDemoState().zoomIndex).toBe(0)
  })

  test('tryExitDemoOnEscape：仅激活时退出并恢复档位', async () => {
    const { getDemoState, enterDemoMode, tryExitDemoOnEscape } = await import('../useDemoMode')
    expect(tryExitDemoOnEscape()).toBe(false)
    enterDemoMode()
    expect(tryExitDemoOnEscape()).toBe(true)
    expect(getDemoState().active).toBe(false)
    expect(getDemoState().zoomIndex).toBe(0)
    expect(tryExitDemoOnEscape()).toBe(false)
  })
})

describe('cycleDemoZoom（边界）', () => {
  test('跨边界循环（200% → 100%）', async () => {
    const { setDemoZoomIndex, cycleDemoZoom } = await import('../useDemoMode')
    setDemoZoomIndex(4)
    expect(cycleDemoZoom(1)).toBe(1)
  })

  test('反向循环（100% → 200%）', async () => {
    const { cycleDemoZoom } = await import('../useDemoMode')
    expect(cycleDemoZoom(-1)).toBe(2)
  })
})

describe('resetDemoZoom / setDemoZoomIndex', () => {
  test('reset 退出演示并回 100%', async () => {
    const { getDemoState, enterDemoMode, setDemoZoomIndex, resetDemoZoom } = await import('../useDemoMode')
    enterDemoMode()
    setDemoZoomIndex(4)
    resetDemoZoom()
    expect(getDemoState().active).toBe(false)
    expect(getDemoState().zoomIndex).toBe(0)
  })

  test('setDemoZoomIndex 越界 clamp', async () => {
    const { getDemoState, setDemoZoomIndex } = await import('../useDemoMode')
    setDemoZoomIndex(99)
    expect(getDemoState().zoomIndex).toBe(4)
    setDemoZoomIndex(-5)
    expect(getDemoState().zoomIndex).toBe(0)
  })
})
