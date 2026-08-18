/**
 * 维护 API（设置 → 维护）
 *
 * GET  /api/v1/db/health       数据库健康：文件/WAL 大小、各表行数、tombstone 待清理、上次维护
 *                              ?fresh=1 绕过 30s 缓存（设置页「刷新」）
 * GET  /api/v1/db/logs         最近应用日志（环形表，默认 100 条）
 * POST /api/v1/db/maintenance  手动触发一轮维护（tombstone purge + feed 裁剪 + checkpoint）
 * POST /api/v1/db/vacuum       手动 VACUUM（整理物理文件；会短暂锁库，须用户确认后调用）
 *
 * 全部需要鉴权（继承 app 的 authMiddleware）。vacuum 是重操作，调用方 UI 必须弹确认框。
 */

import { Hono } from 'hono'
import { statSync } from 'node:fs'
import { getDb } from '../db'
import { listAppLogs, initAppLogs } from '../services/appLogs'
import { countOrphanTombstones, runMaintenancePass } from '../services/maintenance'
import { logAppEvent } from '../services/appLogs'

const maintenance = new Hono()

// ── health 缓存：/db/health 的 count(*)×10 + 递归 CTE 每次全量重算又慢又阻塞
// ──（SQLite 单线程，查询期间其他请求排队，用户切 Tab 也卡）。缓存 30s，
// ── 维护/整理等写操作后主动失效（invalidateHealthCache），前端 refetch 立刻拿新值。
const HEALTH_CACHE_TTL_MS = 30_000
let healthCache: { ts: number; payload: ReturnType<typeof buildHealthPayload> } | null = null

function invalidateHealthCache(): void {
  healthCache = null
}

function buildHealthPayload() {
  const sizes = dbFileSizes()
  const lastLog = listAppLogs(1)[0] ?? null
  let tombstones = { total: 0, purgeable: 0, retained: 0 }
  try {
    tombstones = countOrphanTombstones(getDb())
  } catch {
    // blocks 表异常时健康页仍返回其余指标
  }
  return {
    dbBytes: sizes.dbBytes,
    walBytes: sizes.walBytes,
    dbPath: sizes.path,
    tables: tableRowCounts(),
    pendingTombstones: tombstones.total,
    purgeableTombstones: tombstones.purgeable,
    retainedTombstones: tombstones.retained,
    lastMaintenance: lastLog && lastLog.source === 'maintenance' ? lastLog : null,
    ts: new Date().toISOString(),
  }
}

/** SQLite 文件大小（DB + WAL，字节）；找不到返回 null */
function dbFileSizes(): { dbBytes: number | null; walBytes: number | null; path: string | null } {
  try {
    const db = getDb()
    // bun:sqlite 没有暴露文件路径；从 pragma 拿
    const row = db.query('PRAGMA database_list').all() as Array<{ name: string; file: string }>
    const main = row.find((r) => r.name === 'main')
    if (!main || !main.file || main.file === '') return { dbBytes: null, walBytes: null, path: null }
    const dbBytes = statSync(main.file).size
    let walBytes: number | null = null
    try {
      walBytes = statSync(`${main.file}-wal`).size
    } catch {
      walBytes = null // WAL 不存在（已 checkpoint 合并）
    }
    return { dbBytes, walBytes, path: main.file }
  } catch {
    return { dbBytes: null, walBytes: null, path: null }
  }
}

/** 主要表行数（维护页健康视图） */
function tableRowCounts(): Record<string, number> {
  const db = getDb()
  const tables = ['blocks', 'block_vectors', 'entities', 'entity_mentions', 'block_refs', 'block_revisions', 'doc_snapshots', 'assets', 'app_logs', 'client_errors']
  const out: Record<string, number> = {}
  for (const t of tables) {
    try {
      const row = db.query(`SELECT count(*) AS c FROM ${t}`).get() as { c: number }
      out[t] = row.c
    } catch {
      out[t] = 0
    }
  }
  return out
}

maintenance.get('/health', (c) => {
  const now = Date.now()
  const fresh = c.req.query('fresh') === '1'
  if (!fresh && healthCache && now - healthCache.ts < HEALTH_CACHE_TTL_MS) {
    return c.json(healthCache.payload)
  }
  const payload = buildHealthPayload()
  healthCache = { ts: now, payload }
  return c.json(payload)
})

maintenance.get('/logs', (c) => {
  const limit = Number(c.req.query('limit') ?? '100')
  const level = c.req.query('level')
  let logs = listAppLogs(limit)
  if (level === 'warn' || level === 'error') {
    logs = logs.filter((l) => l.level === level)
  }
  return c.json({ logs })
})

/** 手动触发一轮维护：tombstone purge + feed 裁剪 + vec 残留 + WAL checkpoint */
maintenance.post('/maintenance', async (c) => {
  const startedAt = Date.now()
  try {
    const r = runMaintenancePass()
    // WAL checkpoint（TRUNCATE 模式：checkpoint 后截断 WAL 文件）
    getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const durationMs = Date.now() - startedAt
    invalidateHealthCache() // 表行数/文件大小都变了，失效缓存让前端立刻拿新值
    logAppEvent({
      level: 'info',
      source: 'maintenance',
      message: 'manual_maintenance_pass',
      fields: { durationMs, tombstoneBlocks: r.tombstones.blocks, revisions: r.tombstones.revisions, docSnapshots: r.tombstones.docSnapshots, feedRows: r.feedRows, vecGenerations: r.vecGenerations },
    })
    return c.json({ ok: true, durationMs, result: r })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logAppEvent({ level: 'error', source: 'maintenance', message: 'manual_maintenance_failed', fields: { durationMs: Date.now() - startedAt, error: msg } })
    return c.json({ ok: false, error: msg }, 500)
  }
})

/** 手动 VACUUM：物理整理（删除页回收）。会短暂锁库（大库可能数秒），UI 须确认。 */
maintenance.post('/vacuum', async (c) => {
  const startedAt = Date.now()
  try {
    const db = getDb()
    // 先 checkpoint 合并 WAL，再 VACUUM 才真正回收页
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.exec('VACUUM')
    const durationMs = Date.now() - startedAt
    invalidateHealthCache()
    logAppEvent({
      level: 'info',
      source: 'maintenance',
      message: 'vacuum_done',
      fields: { durationMs },
    })
    // VACUUM 在 WAL 模式下会把整库重写进 WAL；记日志也会再脏一截。
    // 必须在写完之后 TRUNCATE，否则整理完 WAL 会回涨到接近库文件大小。
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const sizes = dbFileSizes()
    return c.json({ ok: true, durationMs, dbBytesAfter: sizes.dbBytes, walBytesAfter: sizes.walBytes })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logAppEvent({ level: 'error', source: 'maintenance', message: 'vacuum_failed', fields: { durationMs: Date.now() - startedAt, error: msg } })
    return c.json({ ok: false, error: msg }, 500)
  }
})

/** 清理环形日志（主动触发，等价 initAppLogs 的裁剪） */
maintenance.post('/logs/trim', (c) => {
  initAppLogs()
  return c.json({ ok: true })
})

export default maintenance
