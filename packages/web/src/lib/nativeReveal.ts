/**
 * 原生壳打开数据目录（访达 / 资源管理器）。
 * 浏览器形态 no-op——路径是服务器上的，不能假装打开本机文件夹。
 */

import { isNativeShell } from './nativeShell'
import { isTauriShell } from '../hooks/useShell'

type NativeBridge = {
  webkit?: { messageHandlers?: { notefast?: { postMessage: (message: unknown) => void } } }
  __TAURI__?: { core?: { invoke?: (cmd: string) => Promise<unknown> } }
}

export function nativeRevealDataDir(): void {
  const w = window as unknown as NativeBridge
  if (isTauriShell()) {
    void w.__TAURI__?.core?.invoke?.('reveal_data_dir')
    return
  }
  if (!isNativeShell()) return
  w.webkit?.messageHandlers?.notefast?.postMessage({ type: 'revealDataDir' })
}
