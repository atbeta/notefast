/** 原生壳（内嵌 WKWebView / Tauri）模式探测。
 *  index.html 内联防闪烁脚本由 `?native=1`（或 macos|tauri|...）设置
 *  `<html class="native-shell" data-shell="...">`。M3 前浏览器形态为 false。 */
export function isNativeShell(): boolean {
  return typeof document !== 'undefined'
    && document.documentElement.classList.contains('native-shell')
}
