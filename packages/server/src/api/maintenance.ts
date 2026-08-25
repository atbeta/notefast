/**
 * 维护 API（设置 → 维护）
 *
 * GET  /api/v1/db/health       数据库健康：文件/WAL 大小、各表行数、tombstone 待清理、上次维护
 *                              （读维护循环的内存快照；快照为空时返回占位并后台只读补算）
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
import { getMaintenanceHealthSnapshot, refreshHealthSnapshot, runMaintenancePass, TOMBSTONE_RETENTION_MS } from '../services/maintenance'
import { logAppEvent } from '../services/appLogs'

const maintenance = new Hono()

/** tombstone 保留天数（health 返回给前端展示，避免文案硬编码与常量漂移） */
const TOMBSTONE_RETENTION_DAYS = Math.round(TOMBSTONE_RETENTION_MS / 86_400_000)

// ── health 数据来源：维护循环的内存快照（getMaintenanceHealthSnapshot）。
// ── 快照为空（重启后首查）时返回占位，并经 setTimeout 跳出请求栈做只读补算。
// ── 注意：不能在 GET 里跑 runMaintenancePass —— 它是同步的（first await 前
// ── 全在当前栈上执行，照样卡死事件循环），且 purge 是写操作，GET 必须无副作用。

function dbFileSizes(): { dbBytes: number | null; walBytes: number | null; path: string | null } {
  try {
    const db = getDb()
    const row = db.query('PRAGMA database_list').all() as Array<{ name: string; file: string }>
    const main = row.find((r) => r.name === 'main')
    if (!main || !main.file || main.file === '') return { dbBytes: null, walBytes: null, path: null }
    const dbBytes = statSync(main.file).size
    let walBytes: number | null = null
    try {
      walBytes = statSync(`${main.file}-wal`).size
    } catch {
      walBytes = null
    }
    return { dbBytes, walBytes, path: main.file }
  } catch {
    return { dbBytes: null, walBytes: null, path: null }
  }
}

/** 占位路径的后台只读补算：跳出请求栈 + 去重，避免并发首查叠多次刷新 */
let healthRefreshScheduled = false
function scheduleHealthSnapshotRefresh(): void {
  if (healthRefreshScheduled) return
  healthRefreshScheduled = true
  setTimeout(() => {
    healthRefreshScheduled = false
    try {
      refreshHealthSnapshot()
    } catch {
      // 快照生成失败不阻塞 health 返回（占位已给）
    }
  }, 0)
}

maintenance.get('/health', async (c) => {
  const sizes = dbFileSizes()
  const lastLog = listAppLogs(1)[0] ?? null
  const snap = getMaintenanceHealthSnapshot()
  const lastMaintenance = lastLog && lastLog.source === 'maintenance' ? lastLog : null
  // 快照存在 → 直接返回（读内存，零重型查询）
  if (snap) {
    return c.json({
      dbBytes: sizes.dbBytes,
      walBytes: sizes.walBytes,
      dbPath: sizes.path,
      tables: snap.tables,
      pendingTombstones: snap.tombstones.total,
      purgeableTombstones: snap.tombstones.purgeable,
      retainedTombstones: snap.tombstones.retained,
      tombstoneRetentionDays: TOMBSTONE_RETENTION_DAYS,
      lastMaintenance,
      ts: snap.at,
    })
  }
  // 快照为空（从未维护 / 重启后首查）→ 后台只读补算，本次返回占位
  scheduleHealthSnapshotRefresh()
  return c.json({
    dbBytes: sizes.dbBytes,
    walBytes: sizes.walBytes,
    dbPath: sizes.path,
    tables: {},
    pendingTombstones: 0,
    purgeableTombstones: 0,
    retainedTombstones: 0,
    tombstoneRetentionDays: TOMBSTONE_RETENTION_DAYS,
    lastMaintenance,
    ts: new Date().toISOString(),
  })
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
    // 维护本身已在 runMaintenancePass 内部刷新快照，无需额外失效
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
    // VACUUM 后行数不变、文件大小变化；快照由下次维护/手动维护刷新
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
