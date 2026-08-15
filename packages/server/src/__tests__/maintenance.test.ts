/**
 * 维护 API / app_logs 环形日志测试：
 * - app_logs 写读 + 环形裁剪（TTL + 行数上限）
 * - /db/health 返回数据库大小与表行数
 * - /db/logs 返回最近日志
 * - /db/maintenance 手动触发一轮（含 checkpoint）
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import maintenance from '../api/maintenance'
import { logAppEvent, listAppLogs, initAppLogs, APP_LOGS_MAX_ROWS } from '../services/appLogs'

let testDir: string
let app: Hono

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-maint-'))
  initDb(testDir)
  app = new Hono()
  app.route('/api/v1/db', maintenance)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().query('DELETE FROM app_logs').run()
})

describe('app_logs 环形日志', () => {
  test('写入并读取，fields 序列化往返', () => {
    logAppEvent({ level: 'warn', source: 'maintenance', message: 'maintenance_pass', fields: { durationMs: 42, tombstoneBlocks: 3 } })
    const logs = listAppLogs(10)
    expect(logs.length).toBe(1)
    expect(logs[0].source).toBe('maintenance')
    expect(logs[0].level).toBe('warn')
    expect(logs[0].fields).toEqual({ durationMs: 42, tombstoneBlocks: 3 })
  })

  test('行数超上限时裁剪保留最新', () => {
    for (let i = 0; i < APP_LOGS_MAX_ROWS + 50; i++) {
      logAppEvent({ level: 'info', source: 'test', message: `msg-${i}` })
    }
    initAppLogs()
    const count = (getDb().query('SELECT count(*) AS c FROM app_logs').get() as { c: number }).c
    expect(count).toBeLessThanOrEqual(APP_LOGS_MAX_ROWS)
    // 保留的是最新的
    const newest = listAppLogs(1)[0]
    expect(newest.message).toBe(`msg-${APP_LOGS_MAX_ROWS + 49}`)
  })
})

describe('维护 API', () => {
  test('GET /db/health 返回文件大小与表行数', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/db/health'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { dbBytes: number | null; tables: Record<string, number>; pendingTombstones: number }
    expect(typeof body.tables.blocks).toBe('number')
    expect(typeof body.pendingTombstones).toBe('number')
    expect(body.dbBytes).toBeGreaterThan(0)
  })

  test('GET /db/logs 返回最近日志', async () => {
    logAppEvent({ level: 'error', source: 'ai', message: 'chat_failed', fields: { error: 'boom' } })
    const res = await app.fetch(new Request('http://localhost/api/v1/db/logs?limit=10'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { logs: Array<{ message: string; level: string; fields: Record<string, unknown> | null }> }
    expect(body.logs.length).toBe(1)
    expect(body.logs[0].message).toBe('chat_failed')
    expect(body.logs[0].level).toBe('error')
    expect(body.logs[0].fields).toEqual({ error: 'boom' })
  })

  test('POST /db/maintenance 手动触发一轮', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/db/maintenance', { method: 'POST' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; result: { tombstones: { blocks: number } } }
    expect(body.ok).toBe(true)
    expect(typeof body.result.tombstones.blocks).toBe('number')
  })
})
