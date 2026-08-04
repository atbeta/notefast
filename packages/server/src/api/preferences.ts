import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
let prefsDir = ''

export function initPreferences(dataDir: string): void {
  prefsDir = dataDir
}

const prefsSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    locale: z.string().min(2).max(20).optional(),
  })
  .passthrough()

const preferences = new Hono()

function load(): Record<string, unknown> {
  if (!prefsDir) return {}
  try {
    const raw = readFileSync(join(prefsDir, PREFERENCES_FILE), 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function save(data: Record<string, unknown>): void {
  if (!prefsDir) return
  writeFileSync(join(prefsDir, PREFERENCES_FILE), JSON.stringify(data, null, 2) + '\n', 'utf-8')
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
