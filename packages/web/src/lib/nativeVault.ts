/**
 * 从网页侧发起「打开文件夹为 vault」/「回到数据库模式」（RFC 0005：壳体只做进程管理）。
 *
 * 为什么只能由壳来做：切换模式要**重启引擎**（`VAULT_PATH` 是启动期参数），网页没有这个能力。
 * 浏览器形态下一律返回 false，调用方不要渲染入口——不要给浏览器用户一个点了没反应的按钮。
 *
 * 各壳的通道：
 * - Tauri（Windows）：`window.__TAURI__.core.invoke`（conf 里 withGlobalTauri: true）
 * - macOS：WKWebView 的 `messageHandlers.notefast`（与 revealDataDir 同一条桥）
 */

import { isTauriShell, getShell } from '../hooks/useShell'

type NativeBridge = {
  webkit?: { messageHandlers?: { notefast?: { postMessage: (message: unknown) => void } } }
}

type TauriGlobal = {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
}

/** 当前有没有「切模式」通道（浏览器形态没有） */
export function canSwitchModeFromShell(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  if (isTauriShell(getShell())) return Boolean((window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__?.core?.invoke)
  const w = window as unknown as NativeBridge
  return Boolean(w.webkit?.messageHandlers?.notefast)
}

/**
 * 选文件夹并以 vault 模式打开。
 * 返回 `true` = 已切过去（Tauri 侧会整页跳到新入口）；`false` = 用户取消或没有通道。
 * macOS 壳自己重启引擎并重新加载页面，这里不跳。
 */
export async function nativePickVaultFolder(): Promise<boolean> {
  if (isTauriShell(getShell())) {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
    const invoke = tauri?.core?.invoke
    if (!invoke) return false
    const info = (await invoke('vault_pick_and_open')) as { url?: string } | null
    if (!info?.url) return false
    window.location.replace(info.url)
    return true
  }
  const w = window as unknown as NativeBridge
  if (!w.webkit?.messageHandlers?.notefast) return false
  w.webkit.messageHandlers.notefast.postMessage({ type: 'openVault' })
  return true
}

/** 回到数据库模式（停掉 vault 引擎，用 db 引擎重启）。语义同 `nativePickVaultFolder` */
export async function nativeLeaveVault(): Promise<boolean> {
  if (isTauriShell(getShell())) {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
    const invoke = tauri?.core?.invoke
    if (!invoke) return false
    const info = (await invoke('use_db_mode')) as { url?: string } | null
    if (!info?.url) return false
    window.location.replace(info.url)
    return true
  }
  const w = window as unknown as NativeBridge
  if (!w.webkit?.messageHandlers?.notefast) return false
  w.webkit.messageHandlers.notefast.postMessage({ type: 'leaveVault' })
  return true
}
