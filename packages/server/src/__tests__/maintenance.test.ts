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
import maintenance, { _resetHealthCacheForTests } from '../api/maintenance'
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
  _resetHealthCacheForTests()
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

  test('purgeExpiredTombstonesBatched 清超期 tombstone 且 guard 不残留', async () => {
    const { purgeExpiredTombstonesBatched } = await import('../services/maintenance')
    const db = getDb()
    const now = new Date().toISOString()
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() // 40 天前

    const nb = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    // 超期软删文档（40 天前删除）→ 应被清
    const docId = crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, is_deleted, updated_at, created_at)
       VALUES (?, ?, NULL, ?, 'document', '旧文档', 0, 0, 1, ?, ?)`,
    ).run(docId, nb, docId, old, old)
    // 超期软删子块
    const childId = crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, is_deleted, updated_at, created_at)
       VALUES (?, ?, ?, ?, 'paragraph', '旧内容', 0, 1, 1, ?, ?)`,
    ).run(childId, nb, docId, docId, old, old)
    // 近期软删（未超期）→ 不应被清
    const freshId = crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, is_deleted, updated_at, created_at)
       VALUES (?, ?, NULL, ?, 'document', '新删文档', 0, 0, 1, ?, ?)`,
    ).run(freshId, nb, freshId, now, now)

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const r = purgeExpiredTombstonesBatched(db, cutoff)
    expect(r.blocks).toBe(2) // 文档根 + 子块

    const oldLeft = db.query('SELECT count(*) AS c FROM blocks WHERE id = ? OR id = ?').get(docId, childId) as { c: number }
    expect(oldLeft.c).toBe(0)
    const freshLeft = db.query('SELECT count(*) AS c FROM blocks WHERE id = ?').get(freshId) as { c: number }
    expect(freshLeft.c).toBe(1)
    // guard 不残留
    const guard = db.query('SELECT count(*) AS c FROM sync_consume_guard').get() as { c: number }
    expect(guard.c).toBe(0)
  })

  test('GET /db/health 把超期可清理与保留期内残留分开', async () => {
    const db = getDb()
    const now = new Date().toISOString()
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    const nb = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'H')
    const oldDoc = crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, is_deleted, updated_at, created_at)
       VALUES (?, ?, NULL, ?, 'document', '超期残留', 0, 0, 1, ?, ?)`,
    ).run(oldDoc, nb, oldDoc, old, old)
    const freshDoc = crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, is_deleted, updated_at, created_at)
       VALUES (?, ?, NULL, ?, 'document', '期内残留', 0, 0, 1, ?, ?)`,
    ).run(freshDoc, nb, freshDoc, now, now)

    const res = await app.fetch(new Request('http://localhost/api/v1/db/health?fresh=1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      pendingTombstones: number
      purgeableTombstones: number
      retainedTombstones: number
    }
    expect(body.purgeableTombstones).toBeGreaterThanOrEqual(1)
    expect(body.retainedTombstones).toBeGreaterThanOrEqual(1)
    expect(body.pendingTombstones).toBe(body.purgeableTombstones + body.retainedTombstones)
  })

  test('GET /db/health 计算期间其它请求不被堵住', async () => {
    const healthP = app.fetch(new Request('http://localhost/api/v1/db/health?fresh=1'))
    const logsRes = await app.fetch(new Request('http://localhost/api/v1/db/logs?limit=1'))
    expect(logsRes.status).toBe(200)
    const healthRes = await healthP
    expect(healthRes.status).toBe(200)
  })

  test('GET /db/health 默认走 30s 缓存，fresh=1 绕过', async () => {
    await app.fetch(new Request('http://localhost/api/v1/db/health?fresh=1'))
    logAppEvent({ level: 'info', source: 'test', message: 'cache-bust' })
    const cached = await app.fetch(new Request('http://localhost/api/v1/db/health'))
    const bodyCached = (await cached.json()) as { tables: Record<string, number> }
    expect(bodyCached.tables.app_logs).toBe(0)
    const fresh = await app.fetch(new Request('http://localhost/api/v1/db/health?fresh=1'))
    const bodyFresh = (await fresh.json()) as { tables: Record<string, number> }
    expect(bodyFresh.tables.app_logs).toBeGreaterThan(0)
  })

  test('POST /db/vacuum 之后 WAL 被截断，不会回涨到接近库文件', async () => {
    const db = getDb()
    db.exec('CREATE TABLE IF NOT EXISTS _vac_pad (b BLOB)')
    const chunk = new Uint8Array(32 * 1024)
    const ins = db.query('INSERT INTO _vac_pad (b) VALUES (?)')
    for (let i = 0; i < 80; i++) ins.run(chunk)

    const res = await app.fetch(new Request('http://localhost/api/v1/db/vacuum', { method: 'POST' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; dbBytesAfter: number | null; walBytesAfter: number | null }
    expect(body.ok).toBe(true)
    expect(body.dbBytesAfter).toBeGreaterThan(1024 * 1024)
    expect(body.walBytesAfter ?? 0).toBeLessThan(256 * 1024)
  })
})
