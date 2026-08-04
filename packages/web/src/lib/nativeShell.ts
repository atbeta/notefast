/** 原生壳（内嵌 WKWebView / Tauri）模式探测。
 *  index.html 内联防闪烁脚本由 `?native=1`（或 macos|tauri|...）设置
 *  `<html class="native-shell" data-shell="...">`（见 index.html 原生壳探测注释）。 */
export function isNativeShell(): boolean {
  return typeof document !== 'undefined'
    && document.documentElement.classList.contains('native-shell')
}

/**
 * 右键菜单屏蔽（main.tsx 挂载前调用；浏览器形态自动跳过）：
 * 壳层（WebView2 / WKWebView）里浏览器默认右键菜单
 * （查看源代码 / 刷新 / 打印 / 检查元素）在桌面应用中违和，一律拦截；
 * 输入区（input / textarea / select / contenteditable，含 CodeMirror 编辑器）
 * 保留默认菜单——复制 / 粘贴 / 拼写检查是桌面应用刚需。
 */
export function initNativeShell(): void {
  if (!isNativeShell()) return

  document.addEventListener('contextmenu', (e) => {
    const el = e.target as HTMLElement | null
    const editable = el?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
    if (!editable) e.preventDefault()
  })
}
