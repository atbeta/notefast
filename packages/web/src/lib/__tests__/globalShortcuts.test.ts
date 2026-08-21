import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  handleGlobalKeyDown,
  overlayBlocksEscape,
  collectBlockingOverlays,
  type GlobalKeyEvent,
  type OverlayLike,
} from '../globalShortcuts'
import {
  enterDemoMode,
  exitDemoMode,
  getDemoState,
  resetDemoZoom,
} from '../../hooks/useDemoMode'

function ev(partial: Partial<GlobalKeyEvent> & { key: string }): GlobalKeyEvent {
  const e: GlobalKeyEvent = {
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault: () => {
      e.defaultPrevented = true
    },
    ...partial,
  }
  return e
}

function overlay(partial: OverlayLike = {}): OverlayLike {
  return {
    hidden: false,
    getAttribute: () => null,
    hasAttribute: () => false,
    closest: () => null,
    ...partial,
  }
}

beforeEach(() => {
  resetDemoZoom()
})

afterEach(() => {
  exitDemoMode()
})

describe('handleGlobalKeyDown · Escape', () => {
  test('演示中按 Esc → 退出演示', () => {
    enterDemoMode()
    expect(getDemoState().active).toBe(true)
    const e = ev({ key: 'Escape' })
    const handled = handleGlobalKeyDown(e, {})
    expect(handled).toBe(true)
    expect(getDemoState().active).toBe(false)
  })

  test('非演示中按 Esc → 不处理、不 preventDefault', () => {
    const e = ev({ key: 'Escape' })
    const handled = handleGlobalKeyDown(e, {})
    expect(handled).toBe(false)
    expect(e.defaultPrevented).toBe(false)
  })

  test('有打开的 dialog/menu 时按 Esc → 不退出演示（对话框优先）', () => {
    enterDemoMode()
    const e = ev({ key: 'Escape' })
    const handled = handleGlobalKeyDown(e, { hasBlockingOverlay: true })
    expect(handled).toBe(false)
    expect(getDemoState().active).toBe(true)
  })

  test('常驻但 aria-hidden 的 overlay 不拦截（CommandPalette 关闭态）', () => {
    enterDemoMode()
    const e = ev({ key: 'Escape' })
    const handled = handleGlobalKeyDown(e, { hasBlockingOverlay: false })
    expect(handled).toBe(true)
    expect(getDemoState().active).toBe(false)
  })

  test('输入框内按 Esc → 不退出演示', () => {
    enterDemoMode()
    const e = ev({ key: 'Escape' })
    const handled = handleGlobalKeyDown(e, { inEditable: true })
    expect(handled).toBe(false)
    expect(getDemoState().active).toBe(true)
  })
})

describe('handleGlobalKeyDown · Ctrl 缩放', () => {
  test('Ctrl+= 放大；Ctrl+- 缩小；Ctrl+0 复位并退出演示', () => {
    enterDemoMode()
    const plus = ev({ key: '=', ctrlKey: true })
    expect(handleGlobalKeyDown(plus, {})).toBe(true)
    expect(getDemoState().zoomIndex).toBeGreaterThan(0)

    const minus = ev({ key: '-', ctrlKey: true })
    handleGlobalKeyDown(minus, {})
    const zero = ev({ key: '0', ctrlKey: true })
    expect(handleGlobalKeyDown(zero, {})).toBe(true)
    expect(getDemoState().zoomIndex).toBe(0)
    expect(getDemoState().active).toBe(false)
  })

  test('输入框内 Ctrl+= 不抢（留给文本操作）', () => {
    const e = ev({ key: '=', ctrlKey: true })
    const handled = handleGlobalKeyDown(e, { inEditable: true })
    expect(handled).toBe(false)
  })
})

describe('overlayBlocksEscape', () => {
  test('打开的 dialog 拦截', () => {
    expect(overlayBlocksEscape(overlay())).toBe(true)
  })

  test('aria-hidden=true 不拦截（关着的全屏 CommandPalette：盒子仍在）', () => {
    expect(
      overlayBlocksEscape(
        overlay({ getAttribute: (n) => (n === 'aria-hidden' ? 'true' : null) }),
      ),
    ).toBe(false)
  })

  test('祖先 aria-hidden 不拦截', () => {
    expect(
      overlayBlocksEscape(overlay({ closest: (sel) => (sel === '[aria-hidden="true"]' ? {} : null) })),
    ).toBe(false)
  })

  test('hidden 属性不拦截', () => {
    expect(overlayBlocksEscape(overlay({ hidden: true, hasAttribute: (n) => n === 'hidden' }))).toBe(false)
  })
})

describe('collectBlockingOverlays', () => {
  test('过滤 aria-hidden，只留下打开的 overlay', () => {
    const openDialog = overlay()
    const closedPalette = overlay({ getAttribute: (n) => (n === 'aria-hidden' ? 'true' : null) })
    const doc = {
      querySelectorAll: () => [openDialog, closedPalette],
    } as unknown as Document
    const overlays = collectBlockingOverlays(doc)
    expect(overlays).toHaveLength(1)
    expect(overlays[0]).toBe(openDialog as unknown as Element)
  })

  test('空 DOM 返回空数组', () => {
    const doc = { querySelectorAll: () => [] } as unknown as Document
    expect(collectBlockingOverlays(doc)).toHaveLength(0)
  })
})
