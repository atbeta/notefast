/**
 * 原生壳探测（index.html 内联脚本 + nativeShell.ensureNativeShell）：
 * - 浏览器形态：无 data-shell
 * - Tauri 壳（Windows / 未来 Linux）：data-shell = tauri | windows | linux
 * - macOS 壳（WKWebView）：data-shell = macos
 *
 * 入口 URL 的 `?native=` 在 SPA 导航后会丢失；刷新时由 sessionStorage /
 * `__TAURI__` 回补，见 `lib/nativeShell.ts`。
 *
 * 壳专属 UI（如自绘标题栏）必须经 isTauriShell 精确 gate，
 * 避免 macOS 壳（有系统标题栏）与浏览器形态被影响。
 */

export function getShell(): string | null {
  return document.documentElement.getAttribute('data-shell')
}

/** Tauri 家族壳（自带 Tauri window API，可安全调用窗口控制） */
export function isTauriShell(shell: string | null = getShell()): boolean {
  return shell === 'tauri' || shell === 'windows' || shell === 'linux'
}
