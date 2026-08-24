/**
 * 全局快捷键核心逻辑（与 DOM 绑定点分离，方便单测）。
 *
 * - Ctrl+=/-/0：阅读态随时能调缩放（输入区不抢）
 * - Esc：演示中退出（输入区不抢，留给标题/对话框；已 preventDefault 的 Esc 也不抢）
 *
 * CommandPalette 关着也常驻 DOM（为了淡出动画），关着时必须带 aria-hidden，
 * 不能再当 dialog。拦截 Esc 只认「未隐藏」的 overlay，不要用 getClientRects：
 * 关着的全屏面板 opacity:0 仍占整屏盒子，rects 永远非空。
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
  /** 当前是否有真正挡住 Esc 的 dialog/menu（关着的常驻层不算） */
  hasBlockingOverlay?: boolean
}

/** 返回 true 表示事件已被处理（调用方应 preventDefault） */
export function handleGlobalKeyDown(e: GlobalKeyEvent, doc: GlobalKeyDoc = {}): boolean {
  if (e.key === 'Escape') {
    if (doc.inEditable || e.defaultPrevented) return false
    // 真正打开的对话框 / 菜单优先吃掉 Esc，勿连带退出演示
    if (doc.hasBlockingOverlay) return false
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

/** 阅读态进入编辑：⌘E / Ctrl+E（编辑器内同键留给行内代码） */
export function isEnterEditShortcut(e: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return false
  return e.key.toLowerCase() === 'e'
}

/** querySelector 命中节点上、用来判断是否抢走 Esc 的最小表面 */
export interface OverlayLike {
  hidden?: boolean
  getAttribute?(name: string): string | null
  hasAttribute?(name: string): boolean
  closest?(selector: string): unknown
}

/** 关着的 overlay：hidden / aria-hidden（含祖先），不拦截 Esc 退出演示 */
export function overlayBlocksEscape(el: OverlayLike): boolean {
  if (el.hidden || el.hasAttribute?.('hidden')) return false
  if (el.getAttribute?.('aria-hidden') === 'true') return false
  if (el.closest?.('[aria-hidden="true"]')) return false
  return true
}

/** 采集当前会抢走 Esc 的 overlay（打开中的 dialog/menu） */
export function collectBlockingOverlays(doc: Document): Element[] {
  return Array.from(
    doc.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"]'),
  ).filter((el) => overlayBlocksEscape(el))
}
