/**
 * Theme hook — 三档主题（light / dark / system）+ 系统跟随
 *
 * 持久化：localStorage 'notefast.theme' = 'light' | 'dark' | 'system'
 * 渲染：<html data-theme="light|dark"> 由防闪烁脚本（在 index.html 内联）
 *       和本 hook 在系统变化时同步更新。
 *
 * 注意：CSS 只识别 data-theme="light|dark"，所以 'system' 在 JS 层
 * 解析为实际 light/dark 后再写到 data-theme 上。
 */

import { useSyncExternalStore } from 'react'

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

function applyDataTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', resolved)
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

/** 切换主题：写 localStorage（唯一一份持久化逻辑）+ 更新 store */
function setThemeChoice(next: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // ignore — 隐私模式 / 配额满时不影响 UI
  }
  setState({ choice: next })
}

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