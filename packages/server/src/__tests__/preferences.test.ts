/**
 * UI 偏好 API 测试
 *
 * - GET /api/v1/preferences：空文件返回 {}，写入后返回完整对象
 * - PUT /api/v1/preferences：合并写入 data/ui-preferences.json，非法值 400
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app'
import { initPreferences } from '../api/preferences'

let testDir: string
let app: ReturnType<typeof createApp>

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'nf-prefs-'))
  app = createApp({ dataDir: testDir })
  initPreferences(testDir)
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('preferences API', () => {
  test('GET 初始为空对象', async () => {
    const res = await app.app.request('/api/v1/preferences')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  test('PUT 合并写入并落盘', async () => {
    const r1 = await app.app.request('/api/v1/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' }),
    })
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ theme: 'dark' })

    const r2 = await app.app.request('/api/v1/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'en' }),
    })
    expect((await r2.json()) as Record<string, unknown>).toEqual({ theme: 'dark', locale: 'en' })

    // 文件已落盘
    const file = join(testDir, 'ui-preferences.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ theme: 'dark', locale: 'en' })

    // GET 返回合并结果
    const g = await app.app.request('/api/v1/preferences')
    expect(await g.json()).toEqual({ theme: 'dark', locale: 'en' })
  })

  test('非法 theme 值 400', async () => {
    const res = await app.app.request('/api/v1/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'neon' }),
    })
    expect(res.status).toBe(400)
  })
})
