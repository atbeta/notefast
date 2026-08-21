import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  handleGlobalKeyDown,
  collectVisibleOverlays,
  type GlobalKeyEvent,
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

beforeEach(() => {
  resetDemoZoom()
})

afterEach(() => {
  exitDemoMode()
})

describe('handleGlobalKeyDown · Escape', () => {
  test('演示中按 Esc → 退出演示（preventDefault 由调用方负责）', () => {
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

  test('有可见 dialog/menu 时按 Esc → 不退出演示（对话框优先）', () => {
    enterDemoMode()
    const e = ev({ key: 'Escape' })
    const handled = handleGlobalKeyDown(e, { visibleOverlays: [{ id: 'open-menu' }] })
    expect(handled).toBe(false)
    expect(getDemoState().active).toBe(true)
  })

  test('有「隐藏」dialog/menu 时按 Esc → 仍退出演示（只拦截可见元素）', () => {
    enterDemoMode()
    const e = ev({ key: 'Escape' })
    const handled = handleGlobalKeyDown(e, { visibleOverlays: [] })
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
    const before0 = getDemoState().zoomIndex
    const zero = ev({ key: '0', ctrlKey: true })
    expect(handleGlobalKeyDown(zero, {})).toBe(true)
    expect(getDemoState().zoomIndex).toBe(0)
    expect(getDemoState().active).toBe(false)
    void before0
  })

  test('输入框内 Ctrl+= 不抢（留给文本操作）', () => {
    const e = ev({ key: '=', ctrlKey: true })
    const handled = handleGlobalKeyDown(e, { inEditable: true })
    expect(handled).toBe(false)
  })
})

describe('collectVisibleOverlays', () => {
  test('排除隐藏元素（getClientRects 为空）', () => {
    const visible = { getClientRects: () => [{ width: 1, height: 1 }] }
    const hidden = { getClientRects: () => [] }
    const doc = {
      querySelectorAll: () => [visible, hidden],
    } as unknown as Document
    const overlays = collectVisibleOverlays(doc)
    expect(overlays).toHaveLength(1)
  })

  test('空 DOM 返回空数组', () => {
    const doc = { querySelectorAll: () => [] } as unknown as Document
    expect(collectVisibleOverlays(doc)).toHaveLength(0)
  })
})