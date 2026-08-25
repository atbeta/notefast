import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createJsonConfigStore } from '../services/jsonConfig'

/**
 * UI 偏好（主题 / 语言等设备本地设置）
 *
 * 为什么存服务端而非 localStorage：原生壳（Tauri/WKWebView）加载 engine 的
 * 随机端口（--port 0），origin 每次变化导致 localStorage 不持久。偏好文件在
 * data/ 目录（固定路径），三种形态（浏览器 / Windows / macOS 壳）统一持久化。
 *
 * 文件不入同步协议、不入 SQLite 快照——设备本地偏好，换设备各自为政。
 */

const PREFERENCES_FILE = 'ui-preferences.json'

const prefsStore = createJsonConfigStore<Record<string, unknown>>({
  fileName: PREFERENCES_FILE,
  empty: () => ({}),
  parse: (raw) => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null),
  uninitializedSet: 'ignore',
})

export function initPreferences(dataDir: string): void {
  prefsStore.init(dataDir)
}

const prefsSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    locale: z.string().min(2).max(20).optional(),
  })
  .passthrough()

const preferences = new Hono()

function load(): Record<string, unknown> {
  return prefsStore.get()
}

/** 给 engine 吐 index.html 用：已 init 后的内存态，不走 HTTP */
export function getUiPreferences(): Record<string, unknown> {
  return load()
}

function save(data: Record<string, unknown>): void {
  prefsStore.set(data)
}

preferences.get('/', (c) => {
  return c.json(load())
})

preferences.put('/', zValidator('json', prefsSchema), (c) => {
  const patch = c.req.valid('json')
  const merged = { ...load(), ...patch }
  save(merged)
  return c.json(merged)
})

export default preferences
