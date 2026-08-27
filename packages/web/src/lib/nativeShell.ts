/** 原生壳（内嵌 WKWebView / Tauri）模式探测。
 *  index.html 内联防闪烁脚本由 `?native=1`（或 macos|tauri|...）设置
 *  `<html class="native-shell" data-shell="...">`（见 index.html 原生壳探测注释）。
 *
 *  SPA 导航会丢掉入口 URL 的 `?native=`。Ctrl+R / F5 整页刷新后若只认 query，
 *  Windows 无边框窗的自绘标题栏会消失。因此探测顺序：
 *  1. URL `?native=`
 *  2. sessionStorage（同 tab 刷新仍在）
 *  3. `window.__TAURI__`（Tauri 注入，与 URL 无关）
 *  逻辑须与 index.html 内联脚本保持一致。 */

export const NATIVE_SHELL_STORAGE_KEY = 'notefast.native-shell'

const SHELL_RE = /^(macos|tauri|windows|linux)$/
const NATIVE_QUERY_RE = /[?&]native=(1|macos|tauri|windows|linux)/

export function isNativeShell(): boolean {
  return typeof document !== 'undefined'
    && document.documentElement.classList.contains('native-shell')
}

/** 从入口 query 解析壳名；`native=1` 视为 tauri（旧约定） */
export function parseNativeQuery(search: string): string | null {
  const m = search.match(NATIVE_QUERY_RE)
  if (!m) return null
  return m[1] === '1' ? 'tauri' : m[1]
}

export function isKnownNativeShell(value: string | null | undefined): value is string {
  return !!value && SHELL_RE.test(value)
}

/** 解析当前应启用的壳身份。query > 已持久化 > Tauri 全局对象 */
export function resolveNativeShell(input: {
  search?: string
  stored?: string | null
  hasTauri?: boolean
}): string | null {
  const fromQuery = parseNativeQuery(input.search ?? '')
  if (fromQuery) return fromQuery
  if (isKnownNativeShell(input.stored)) return input.stored
  if (input.hasTauri) return 'tauri'
  return null
}

export function readStoredNativeShell(): string | null {
  try {
    return sessionStorage.getItem(NATIVE_SHELL_STORAGE_KEY)
  } catch {
    return null
  }
}

export function persistNativeShell(shell: string): void {
  if (!isKnownNativeShell(shell)) return
  try {
    sessionStorage.setItem(NATIVE_SHELL_STORAGE_KEY, shell)
  } catch {
    /* quota / 隐私模式 */
  }
}

export function applyNativeShellMarker(
  shell: string,
  root: Pick<HTMLElement, 'classList' | 'setAttribute'> = document.documentElement,
): void {
  if (!isKnownNativeShell(shell)) return
  root.classList.add('native-shell')
  root.setAttribute('data-shell', shell)
}

function hasTauriGlobal(): boolean {
  return typeof window !== 'undefined'
    && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__
}

/**
 * 在 React 挂载前补齐 data-shell（刷新后 URL 已无 native 参数时尤其关键）。
 * 返回解析到的壳名；浏览器形态返回 null。
 */
export function ensureNativeShell(): string | null {
  if (typeof document === 'undefined') return null
  const existing = document.documentElement.getAttribute('data-shell')
  const shell = resolveNativeShell({
    search: typeof location !== 'undefined' ? location.search : '',
    stored: readStoredNativeShell(),
    hasTauri: hasTauriGlobal(),
  }) ?? (isKnownNativeShell(existing) ? existing : null)
  if (!shell) return null
  applyNativeShellMarker(shell)
  persistNativeShell(shell)
  return shell
}

/** F5 / Ctrl+R / Cmd+R / Ctrl+Shift+R：桌面壳不应走浏览器刷新 */
export function isNativeReloadShortcut(e: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
}): boolean {
  if (e.key === 'F5') return true
  if (!(e.ctrlKey || e.metaKey)) return false
  return e.key === 'r' || e.key === 'R'
}

/**
 * 右键菜单屏蔽 + 拦截整页刷新（main.tsx 挂载前调用；浏览器形态自动跳过）：
 * 壳层（WebView2 / WKWebView）里浏览器默认右键菜单
 * （查看源代码 / 刷新 / 打印 / 检查元素）在桌面应用中违和，一律拦截；
 * 输入区（input / textarea / select / contenteditable，含 CodeMirror 编辑器）
 * 保留默认菜单——复制 / 粘贴 / 拼写检查是桌面应用刚需。
 */
export function initNativeShell(): void {
  ensureNativeShell()
  if (!isNativeShell()) return

  document.addEventListener('contextmenu', (e) => {
    const el = e.target as HTMLElement | null
    const editable = el?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
    if (!editable) e.preventDefault()
  })

  document.addEventListener('keydown', (e) => {
    if (isNativeReloadShortcut(e)) e.preventDefault()
  }, true)
}
