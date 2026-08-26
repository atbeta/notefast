/**
 * 原生壳打开数据目录（访达 / 资源管理器）。
 * 浏览器形态 no-op——路径是服务器上的，不能假装打开本机文件夹。
 */

import { isNativeShell } from './nativeShell'
import { isTauriShell } from '../hooks/useShell'

type NativeBridge = {
  webkit?: { messageHandlers?: { notefast?: { postMessage: (message: unknown) => void } } }
}

/** Tauri 传入绝对路径（页面上已有）；macOS 壳走 WK 桥，由原生侧自己解析数据目录。 */
export async function nativeRevealDataDir(dir?: string): Promise<void> {
  if (isTauriShell()) {
    if (!dir) throw new Error('missing data dir')
    const { openPath } = await import('@tauri-apps/plugin-opener')
    await openPath(dir)
    return
  }
  if (!isNativeShell()) return
  const w = window as unknown as NativeBridge
  w.webkit?.messageHandlers?.notefast?.postMessage({ type: 'revealDataDir' })
}
