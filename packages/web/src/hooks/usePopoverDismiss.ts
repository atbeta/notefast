import { useEffect, type RefObject } from 'react'

/**
 * popover / 菜单 dismiss 收口（原七处手写同一套监听）：
 * - Esc → onClose（可用 onEscape 自定义，如阻止冒泡到全局快捷键）
 * - 外部 mousedown → onClose（refs 内点击不算外部）
 * - 可选：滚动捕获（内部列表滚动也算）/ 窗口缩放 → onClose
 *
 * open=false 时零开销（不绑定任何监听）；refs 传 ref 对象本身（引用稳定）。
 */
export interface PopoverDismissOptions {
  onClose: () => void
  /** 自定义 Esc（默认 = onClose；可在回调里对 event 做 preventDefault/stopPropagation） */
  onEscape?: (e: KeyboardEvent) => void
  /** 忽略外部 mousedown（如流式期间保持气泡可达） */
  ignoreOutsideClick?: boolean
  /** 滚动（捕获）时关闭 */
  closeOnScroll?: boolean
  /** 窗口缩放时关闭 */
  closeOnResize?: boolean
}

export function usePopoverDismiss(
  open: boolean,
  opts: PopoverDismissOptions,
  ...refs: Array<RefObject<HTMLElement | null> | null | undefined>
): void {
  const { onClose, onEscape, ignoreOutsideClick, closeOnScroll, closeOnResize } = opts
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // stopPropagation：菜单开着按 Esc 只关菜单，不让事件冒泡到 window 全局
      // handler（否则全局会 querySelector 命中「正在卸载的菜单 DOM」直接 return，
      // 连带把「Esc 退出演示」吞掉——菜单关不掉、演示也退不出）
      e.stopPropagation()
      if (onEscape) onEscape(e)
      else onClose()
    }
    const onDown = (e: MouseEvent) => {
      if (ignoreOutsideClick) return
      const target = e.target as Node
      for (const r of refs) {
        if (r?.current?.contains(target)) return
      }
      onClose()
    }
    const onScrollOrResize = () => {
      if (ignoreOutsideClick) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    if (closeOnScroll) window.addEventListener('scroll', onScrollOrResize, true)
    if (closeOnResize) window.addEventListener('resize', onScrollOrResize)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      if (closeOnScroll) window.removeEventListener('scroll', onScrollOrResize, true)
      if (closeOnResize) window.removeEventListener('resize', onScrollOrResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs 引用稳定；opts 字段已单独展开
  }, [open, onClose, onEscape, ignoreOutsideClick, closeOnScroll, closeOnResize, ...refs])
}
