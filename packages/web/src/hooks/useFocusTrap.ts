/**
 * useFocusTrap — 模态焦点管理
 *
 * 用法：把 ref 挂到弹窗的「内容容器」（非遮罩），返回的属性绑到该元素。
 * 自动行为：
 *  - 打开时记录原 activeElement，关闭后还原
 *  - 容器内 Tab/Shift+Tab 循环焦点（仅在容器内有可聚焦元素时）
 *  - 容器存在但内部无 focusable 时，自身设为 tabindex=-1 并 focus（保证 Esc/Enter 等全局键可达）
 *
 * 设计取舍：
 *  - 不用 focus-trap 库：避免依赖膨胀；行为简单稳定。
 *  - 不抢"首次聚焦谁"：调用方在 useEffect 里主动 focus 需要的元素；
 *    hook 只在没找到时回退聚焦到容器本身。
 */
import { useEffect, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
  )
}

/** Tab/Shift+Tab 循环判定（纯函数，可单测） */
export function pickNextFocus(
  focusables: HTMLElement[],
  active: HTMLElement | null,
  shift: boolean,
  container: HTMLElement,
): HTMLElement | null {
  if (focusables.length === 0) return null
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const inContainer = active && container.contains(active)
  if (shift) {
    if (active === first || !inContainer) return last
    return null
  }
  if (active === last || !inContainer) return first
  return null
}

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return

    const previouslyFocused = document.activeElement as HTMLElement | null

    // 等待 React 提交 DOM 后再聚焦（弹窗内容可能在 effect 之后才挂载）
    const focusFirst = () => {
      const focusables = getFocusable(container)
      if (focusables.length > 0) {
        focusables[0].focus()
      } else if (!container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '-1')
        container.focus()
      }
    }
    const raf = requestAnimationFrame(focusFirst)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const focusables = getFocusable(container)
      if (focusables.length === 0) {
        e.preventDefault()
        container.focus()
        return
      }
      const activeEl = document.activeElement as HTMLElement | null
      const target = pickNextFocus(focusables, activeEl, e.shiftKey, container)
      if (target) {
        e.preventDefault()
        target.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', handleKeyDown)
      // 还原焦点：优先回到打开弹窗前的元素。
      // 必须 preventScroll —— 原焦点若是 CodeMirror contentDOM（整篇文档高度），
      // 浏览器 focus 默认 scrollIntoView 会把元素顶部对齐视口，表现为「关闭弹窗跳回文档头」
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus({ preventScroll: true })
      }
    }
  }, [ref, active])
}