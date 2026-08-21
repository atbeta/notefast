/**
 * 全局快捷键核心逻辑（与 DOM 绑定点分离，方便单测）。
 *
 * - Ctrl+=/-/0：阅读态随时能调缩放（输入区不抢）
 * - Esc：演示中退出（输入区不抢，留给标题/对话框；已 preventDefault 的 Esc 也不抢）
 *
 * 注意：菜单/popover 开着时按 Esc，usePopoverDismiss 会 stopPropagation，
 * 事件到不了这里——所以「菜单开着 Esc 关菜单」不会误触退出演示。
 */

import { cycleDemoZoom, resetDemoZoom, tryExitDemoOnEscape } from '../hooks/useDemoMode'

export interface GlobalKeyEvent {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  defaultPrevented?: boolean
  target?: unknown
  preventDefault: () => void
}

export interface GlobalKeyDoc {
  /** e.target 是否可编辑（INPUT/TEXTAREA/contentEditable） */
  inEditable?: boolean
  /**
   * 当前「可见」的 dialog/menu 列表。
   * 只统计可见元素（getClientRects 非空）——组件可能把弹层常驻在 DOM 里
   * 但隐藏（display:none / 未定位），不拦截 Esc 到退出演示。
   */
  visibleOverlays?: unknown[]
}

/** 返回 true 表示事件已被处理（调用方应 preventDefault） */
export function handleGlobalKeyDown(e: GlobalKeyEvent, doc: GlobalKeyDoc = {}): boolean {
  if (e.key === 'Escape') {
    if (doc.inEditable || e.defaultPrevented) return false
    // 对话框 / 菜单优先吃掉 Esc，勿连带退出演示
    if (doc.visibleOverlays && doc.visibleOverlays.length > 0) return false
    return tryExitDemoOnEscape()
  }

  const mod = e.metaKey || e.ctrlKey
  if (!mod) return false
  if (doc.inEditable) return false
  if (e.key === '=' || e.key === '+') {
    cycleDemoZoom(1)
    return true
  }
  if (e.key === '-' || e.key === '_') {
    cycleDemoZoom(-1)
    return true
  }
  if (e.key === '0') {
    resetDemoZoom()
    return true
  }
  return false
}

/** 采集当前可见 overlay：只认可见元素（getClientRects 非空） */
export function collectVisibleOverlays(doc: Document): unknown[] {
  return Array.from(
    doc.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"]'),
  ).filter((el) => {
    try {
      return el.getClientRects().length > 0
    } catch {
      return false
    }
  })
}