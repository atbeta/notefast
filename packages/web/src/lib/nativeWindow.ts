/**
 * 原生壳窗口控制（macOS WKWebView / Tauri）。
 *
 * 双击标题栏区域 → 最大化/恢复：
 * - Tauri：window.toggleMaximize（与 TitleBar 双击同路）
 * - macOS：经 messageHandlers.notefast 调 NSWindow.zoom（系统绿键同款）
 * - 浏览器：no-op
 */

import { isTauriShell } from '../hooks/useShell'
import { isNativeShell } from './nativeShell'

type NativeBridge = {
  webkit?: { messageHandlers?: { notefast?: { postMessage: (message: unknown) => void } } }
  __TAURI__?: { window?: { getCurrentWindow?: () => { toggleMaximize: () => Promise<void> } } }
}

/** 双击拖拽区时调用；点在可交互子元素上应先由调用方过滤 */
export function nativeToggleWindowZoom(): void {
  const w = window as unknown as NativeBridge
  if (isTauriShell()) {
    void w.__TAURI__?.window?.getCurrentWindow?.().toggleMaximize()
    return
  }
  if (!isNativeShell()) return
  w.webkit?.messageHandlers?.notefast?.postMessage({ type: 'windowZoom' })
}

/** 忽略按钮/链接等可交互目标上的双击（留给业务；空白拖拽区才缩放窗口） */
export function isWindowZoomDoubleClickTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !target.closest(
    'button, a, input, textarea, select, [role="button"], [contenteditable], label',
  )
}
