/**
 * NoteFastEditor 设置（NoteFast URL + token）持久化。
 *
 * M2 浏览器形态用 localStorage（`notefast.editor.settings`）；M3 壳层改用
 * Preferences（macOS UserDefaults / Tauri store），本模块是唯一读写入口。
 */

import type { EditorSettings } from '@notefast/shared'

const STORAGE_KEY = 'notefast.editor.settings'

export function loadSettings(): EditorSettings {
  if (typeof localStorage === 'undefined') return { noteFastUrl: '', apiToken: '' }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { noteFastUrl: '', apiToken: '' }
    const parsed = JSON.parse(raw) as Partial<EditorSettings>
    return {
      noteFastUrl: typeof parsed.noteFastUrl === 'string' ? parsed.noteFastUrl : '',
      apiToken: typeof parsed.apiToken === 'string' ? parsed.apiToken : '',
    }
  } catch {
    return { noteFastUrl: '', apiToken: '' }
  }
}

export function saveSettings(settings: EditorSettings): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}
