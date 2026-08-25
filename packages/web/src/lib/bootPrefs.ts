/** engine 吐 index.html 时写入的启动偏好；Vite 开发态没有这份对象 */

export interface BootPrefs {
  theme?: string
  locale?: string
}

declare global {
  interface Window {
    __NF_PREFS?: BootPrefs
  }
}

export function readBootPrefs(): BootPrefs {
  if (typeof window === 'undefined') return {}
  const raw = window.__NF_PREFS
  return raw && typeof raw === 'object' ? raw : {}
}
