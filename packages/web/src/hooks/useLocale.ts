/**
 * Locale hook — 语言选择（跟随浏览器 / 具体语言）
 *
 * 持久化：localStorage 'notefast.locale' = 'system' | '<code>'（首屏缓存）
 *         + 服务端 /api/v1/preferences（权威——原生壳 origin 随 engine 随机端口
 *         变化，localStorage 不持久；浏览器形态双写无副作用）
 * 切换动作：写 localStorage + i18next.changeLanguage() + 同步 <html lang>
 * 渲染：模块级 store + useSyncExternalStore（同 useTheme 模式），
 *       所有实例共享同一份状态，切换即时生效。
 *
 * 注意：<html lang> 初始值由 index.html 内联防闪烁脚本决定，
 *       JS 侧只在用户显式切换时更新。
 */

import { useSyncExternalStore } from 'react'
import i18next from '../i18n'
import { LOCALE_STORAGE_KEY, readStoredLocaleChoice, resolveLocale } from '../i18n/locales'
import { fetchWithAuth } from './useAPI'

export type LocaleChoice = 'system' | string

interface LocaleState {
  /** 用户选择：'system' 或具体语言 code */
  choice: LocaleChoice
  /** 浏览器系统语言（resolve 'system' 时使用） */
  systemLocale: string
}

function systemLocale(): string {
  return typeof navigator !== 'undefined' ? navigator.language : 'zh-CN'
}

function resolve(choice: LocaleChoice, sys: string): string {
  return resolveLocale(choice === 'system' ? undefined : choice, sys)
}

function applyDocLang(lng: string): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lng
  }
}

let state: LocaleState = {
  choice: readStoredLocaleChoice() ?? 'system',
  systemLocale: systemLocale(),
}

const listeners = new Set<() => void>()

/** 更新 store：同步 i18next + <html lang> 并通知所有订阅者 */
function setState(patch: Partial<LocaleState>): void {
  state = { ...state, ...patch }
  const lng = resolve(state.choice, state.systemLocale)
  void i18next.changeLanguage(lng)
  applyDocLang(lng)
  for (const l of listeners) l()
}

/** 切换语言：写 localStorage（首屏缓存）+ 服务端持久化 + 更新 store */
function setLocaleChoice(next: LocaleChoice): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next)
  } catch {
    // ignore — 隐私模式 / 配额满时不影响 UI
  }
  persistToServer({ locale: next })
  setState({ choice: next })
}

/** 服务端持久化（fire-and-forget）：原生壳 origin 不稳定，localStorage 会丢 */
function persistToServer(patch: Record<string, string>): void {
  void fetchWithAuth('/api/v1/preferences', {
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
    const res = await fetchWithAuth('/api/v1/preferences')
    if (!res.ok) return
    const prefs = (await res.json()) as { locale?: string }
    if (prefs.locale) {
      const server: LocaleChoice = prefs.locale === 'system' ? 'system' : prefs.locale
      if (server !== state.choice) {
        try {
          localStorage.setItem(LOCALE_STORAGE_KEY, server)
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): LocaleState {
  return state
}

export interface UseLocaleResult {
  /** 用户选择（含 'system'） */
  choice: LocaleChoice
  /** 实际生效的具体语言 code（永远是受支持语言） */
  locale: string
  /** 切换语言；同时写 localStorage + i18next + <html lang> */
  setLocale: (next: LocaleChoice) => void
}

export function useLocale(): UseLocaleResult {
  const { choice, systemLocale: sys } = useSyncExternalStore(subscribe, getSnapshot)
  return {
    choice,
    locale: resolve(choice, sys),
    setLocale: setLocaleChoice,
  }
}
