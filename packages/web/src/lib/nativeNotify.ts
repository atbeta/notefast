/**
 * 原生壳系统通知通道（macOS WKScriptMessageHandler）。
 *
 * 壳层注册 `window.webkit.messageHandlers.notefast`，web 侧 postMessage 即弹 macOS 通知。
 * 浏览器与 Tauri（WebView2）没有 `window.webkit`，天然 no-op，行为零变化；
 * 非原生壳形态（浏览器直接访问）同样直接跳过。
 */

import { isNativeShell } from './nativeShell'

type NativeBridge = {
  webkit?: { messageHandlers?: { notefast?: { postMessage: (message: unknown) => void } } }
}

export function nativeNotify(title: string, body: string): void {
  if (!isNativeShell()) return
  const w = window as unknown as NativeBridge
  w.webkit?.messageHandlers?.notefast?.postMessage({ type: 'notify', title, body })
}
