/**
 * 原生壳打开文件后走客户端路由，避免 WKWebView / WebView2 整页重载 SPA。
 * Layout 挂载时安装；壳层 evaluate `window.__notefastNavigate(path)`。
 */

export type NativeNavigateFn = (path: string) => void

declare global {
  interface Window {
    __notefastNavigate?: NativeNavigateFn
  }
}

/** 安装壳层可调用的客户端导航；返回卸载函数 */
export function installNativeNavigate(navigate: NativeNavigateFn): () => void {
  window.__notefastNavigate = navigate
  return () => {
    if (window.__notefastNavigate === navigate) delete window.__notefastNavigate
  }
}
