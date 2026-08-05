/**
 * Theme hook — 三档主题（light / dark / system）+ 系统跟随
 *
 * 持久化：localStorage 'notefast.theme' = 'light' | 'dark' | 'system'（首屏缓存）
 *         + 服务端 /api/v1/preferences（权威——原生壳 origin 随 engine 随机端口
 *         变化，localStorage 不持久；浏览器形态双写无副作用）
 * 渲染：<html data-theme="light|dark"> 由防闪烁脚本（在 index.html 内联）
 *       和本 hook 在系统变化时同步更新。
 *
 * 注意：CSS 只识别 data-theme="light|dark"，所以 'system' 在 JS 层
 * 解析为实际 light/dark 后再写到 data-theme 上。
 */

import { useSyncExternalStore } from 'react'
import { fetchWithAuth } from './useAPI'

export type ThemeChoice = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'notefast.theme'
const VALID_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system']

function readStoredChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v && (VALID_CHOICES as readonly string[]).includes(v)) return v as ThemeChoice
  } catch {
    // ignore — localStorage 不可用时退到 system
  }
  return 'system'
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 主题切换瞬间给 <html> 挂 .theme-fading（CSS 里启用颜色过渡），
 *  过渡结束即移除——避免 transition 常驻全元素的开销 */
const THEME_FADE_MS = 180
let themeFadeTimer: ReturnType<typeof setTimeout> | undefined

function applyDataTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  // 首次应用（与当前值相同）不做过渡，避免首屏无意义闪动
  const changed = el.getAttribute('data-theme') !== resolved
  if (changed) el.classList.add('theme-fading')
  el.setAttribute('data-theme', resolved)
  if (changed) {
    if (themeFadeTimer) clearTimeout(themeFadeTimer)
    themeFadeTimer = setTimeout(() => el.classList.remove('theme-fading'), THEME_FADE_MS)
  }
}

function resolveTheme(choice: ThemeChoice, systemDark: boolean): ResolvedTheme {
  if (choice === 'light') return 'light'
  if (choice === 'dark') return 'dark'
  return systemDark ? 'dark' : 'light'
}

// ───────────── 模块级单一 store ─────────────
// 旧实现每个 useTheme() 调用是独立 useState，实例间互不同步
// （命令面板切主题后 Layout 的 resolvedTheme 仍是旧值）。
// 改为模块级 store + useSyncExternalStore，所有实例共享同一份状态。

interface ThemeState {
  choice: ThemeChoice
  systemDark: boolean
}

let state: ThemeState = {
  choice: readStoredChoice(),
  systemDark: systemPrefersDark(),
}

const listeners = new Set<() => void>()

/** 更新 store：同步 <html data-theme> 并通知所有订阅者 */
function setState(patch: Partial<ThemeState>): void {
  state = { ...state, ...patch }
  applyDataTheme(resolveTheme(state.choice, state.systemDark))
  for (const l of listeners) l()
}

/** 切换主题：写 localStorage（首屏缓存）+ 服务端持久化 + 更新 store */
function setThemeChoice(next: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // ignore — 隐私模式 / 配额满时不影响 UI
  }
  persistToServer({ theme: next })
  setState({ choice: next })
}

/** 服务端持久化（fire-and-forget）：原生壳 origin 不稳定，localStorage 会丢 */
function persistToServer(patch: Record<string, string>): void {
  void fetchWithAuth('/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(() => {
    // 离线 / 未鉴权：保留本地值，下次加载以服务端为准
  })
}

/** 模块加载时拉取服务端偏好（权威）覆盖本地缓存；失败则保留本地值 */
async function loadServerChoice(): Promise<void> {
  try {
    const res = await fetchWithAuth('/preferences')
    if (!res.ok) return
    const prefs = (await res.json()) as { theme?: string }
    if (prefs.theme && (VALID_CHOICES as readonly string[]).includes(prefs.theme)) {
      const server = prefs.theme as ThemeChoice
      if (server !== state.choice) {
        try {
          localStorage.setItem(STORAGE_KEY, server)
        } catch {
          // ignore
        }
        setState({ choice: server })
      }
    }
  } catch {
    // 服务端不可达：保留本地值
  }
}
void loadServerChoice()

// 系统偏好监听：首个订阅者出现时挂一次，存活期与模块一致
let mediaListenerAttached = false
function ensureMediaListener(): void {
  if (mediaListenerAttached) return
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  mediaListenerAttached = true
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = (e: MediaQueryListEvent) => setState({ systemDark: e.matches })
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler)
  } else {
    // 旧 API 回退（Safari < 14）
    const legacy = mq as unknown as { addListener?: (cb: (e: MediaQueryListEvent) => void) => void }
    legacy.addListener?.(handler)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  ensureMediaListener()
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): ThemeState {
  return state
}

export interface UseThemeResult {
  /** 用户选择（含 'system'） */
  theme: ThemeChoice
  /** 实际生效（永远是 'light' | 'dark'） */
  resolvedTheme: ResolvedTheme
  /** 切换主题；同时写 localStorage + 改 <html data-theme> */
  setTheme: (next: ThemeChoice) => void
}

export function useTheme(): UseThemeResult {
  const { choice, systemDark } = useSyncExternalStore(subscribe, getSnapshot)
  return { theme: choice, resolvedTheme: resolveTheme(choice, systemDark), setTheme: setThemeChoice }
}