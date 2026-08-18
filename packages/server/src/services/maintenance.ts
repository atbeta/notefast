/**
 * 周期维护任务（进程级自重排单循环）：
 *
 * 1. 孤儿 tombstone purge：整篇保存（applyMarkdownReplace）每次软删全部旧子块，
 *    这些非文档 tombstone 与超过保留期的已删文档没有物理清理路径，blocks /
 *    blocks_fts / 修订行单调膨胀。保留期 30 天（对齐回收站列表最长窗口）。
 * 2. 未配置多端同步时 entity_changes 时间裁剪（同步已配置时由 compaction 的
 *    pruneChanges 按快照锚点裁剪，此处跳过）。
 * 3. sqlite-vec retired / failed generation 的虚拟表与条目清理（重建与切换已
 *    即时清理，此处兜底历史残留）。
 *
 * 安全边界：
 * - 清理在 sync_consume_guard 临界区内执行（batched 内部管理 guard 行）——
 *   物理删除不产生新的 change feed 行（tombstone 早已发布，无新增信息；
 *   且避免清理任务自我膨胀）。每 500 批独立提交，批间释放写锁（用户写操作可插入）。
 * - tombstone 的 LWW 语义不受影响：远端对已 purged 块的重放会 INSERT 重建
 *   （块行已不在），软删重放则幂等跳过。
 * - 同步已启用时跳过 feed 时间裁剪：publishedSeq 保护由 pruneStaleChanges
 *   实现，但已发布区间的裁剪权归 compaction（快照锚点是更严的下界）。
 */
import { getDb } from '../db'
import { pruneStaleChanges } from '../store/changeFeed'
import { dropStaleVectorGenerations } from '../ai/vectorStoreVec'
import { isProtocolConfigured, protocolStatus, noteFeedPruned } from '../sync/protocolManager'
import { logAppEvent } from './appLogs'
import { isIdleEnoughForMaintenance } from './activity'

/** 孤儿 tombstone 保留期（对齐回收站 30d 窗口） */
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** 未配置同步时 entity_changes 时间保留期 */
export const FEED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** 首跑延迟（等启动期任务稳定） */
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000
/** 之后每圈间隔 */
const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 距上次请求至少这么久才算空闲，才跑维护（大事务避免撞用户活跃时段） */
const IDLE_REQUIRED_MS = 10 * 60 * 1000

export interface TombstonePurgeResult {
  blocks: number
  revisions: number
  docSnapshots: number
}

export interface MaintenanceResult {
  tombstones: TombstonePurgeResult
  feedRows: number
  vecGenerations: number
}

/** UTC 秒精度 SQL datetime（对齐 entity_changes.changed_at 的 datetime('now') 格式） */
function sqlCutoff(msAgo: number): string {
  const d = new Date(Date.now() - msAgo)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/**
 * 物理清除超过保留期的 tombstone 块及其修订历史。
 *
 * 选取规则（递归 CTE 自顶向下）：
 * - 只选「顶层」tombstone：父块不是 tombstone（其下的 tombstone 后代由 FK
 *   ON DELETE CASCADE 跟随删除，各自触发 blocks_fts_delete 触发器清 FTS）。
 * - 有存活直接子块的 tombstone 整棵跳过：个别「已删父 + 已恢复子」的边角
 *   状态不能连带物理删除恢复过的内容。
 * - 文档根 tombstone 在清理集内时，其 doc_snapshots 一并删除（历史无意义）。
 * 须在 runFeedSuppressed 内调用。
 */
export function purgeExpiredTombstones(db: ReturnType<typeof getDb>, cutoffIso: string): TombstonePurgeResult {
  const rows = db.query(`
    WITH RECURSIVE dead(id, root_id, type) AS (
      SELECT b.id, b.root_id, b.type FROM blocks b
      WHERE b.is_deleted = 1 AND b.updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM blocks p WHERE p.id = b.parent_id AND p.is_deleted = 1)
        AND NOT EXISTS (SELECT 1 FROM blocks c WHERE c.parent_id = b.id AND c.is_deleted = 0)
      UNION ALL
      SELECT b2.id, b2.root_id, b2.type FROM blocks b2 JOIN dead ON b2.parent_id = dead.id
      WHERE b2.is_deleted = 1
    )
    SELECT id, root_id, type FROM dead
  `).all(cutoffIso) as Array<{ id: string; root_id: string; type: string }>

  if (rows.length === 0) return { blocks: 0, revisions: 0, docSnapshots: 0 }
  const ids = rows.map((r) => r.id)
  const docRootIds = rows.filter((r) => r.type === 'document').map((r) => r.id)

  // 先清修订历史（无外键，须显式；block_revisions 覆盖全部清理块，
  // doc_snapshots 只清被清掉的文档根）
  let revisions = 0
  let docSnapshots = 0
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const ph = chunk.map(() => '?').join(',')
    revisions += db.query(`DELETE FROM block_revisions WHERE block_id IN (${ph})`).run(
      ...(chunk as [string, ...string[]]),
    ).changes
  }
  for (let i = 0; i < docRootIds.length; i += 500) {
    const chunk = docRootIds.slice(i, i + 500)
    const ph = chunk.map(() => '?').join(',')
    docSnapshots += db.query(`DELETE FROM doc_snapshots WHERE doc_id IN (${ph})`).run(
      ...(chunk as [string, ...string[]]),
    ).changes
  }

  // 物理删除：FK 级联清 block_refs / entity_mentions / vector_entries；
  // blocks_fts_delete 触发器清 FTS 行；feed 由外层 runFeedSuppressed 抑制。
  // 计数用 CTE 行数而非 .changes——后者会把触发器/FK 级联的副作用一并计入
  let blocks = 0
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const ph = chunk.map(() => '?').join(',')
    db.query(`DELETE FROM blocks WHERE id IN (${ph})`).run(
      ...(chunk as [string, ...string[]]),
    )
    blocks += chunk.length
  }
  return { blocks, revisions, docSnapshots }
}

/**
 * 维护专用：批间提交的 tombstone 物理清理。
 *
 * 与 purgeExpiredTombstones 的差异：每一批（500 块）独立提交事务，批间释放
 * SQLite 写锁——用户突然活跃时的写操作（保存/删除）可以插进来，不会等到
 * 整个清理跑完。guard 行独立管理（feed 抑制靠 guard 存在，不依赖全程事务）。
 *
 * 代价：批间崩溃会留下「前批已删、后批未删」的部分完成状态——tombstone 清理
 * 是幂等且可重跑的（下次维护会再清），可接受。
 */
export function purgeExpiredTombstonesBatched(db: ReturnType<typeof getDb>, cutoffIso: string): TombstonePurgeResult {
  const rows = db.query(`
    WITH RECURSIVE dead(id, root_id, type) AS (
      SELECT b.id, b.root_id, b.type FROM blocks b
      WHERE b.is_deleted = 1 AND b.updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM blocks p WHERE p.id = b.parent_id AND p.is_deleted = 1)
        AND NOT EXISTS (SELECT 1 FROM blocks c WHERE c.parent_id = b.id AND c.is_deleted = 0)
      UNION ALL
      SELECT b2.id, b2.root_id, b2.type FROM blocks b2 JOIN dead ON b2.parent_id = dead.id
      WHERE b2.is_deleted = 1
    )
    SELECT id, root_id, type FROM dead
  `).all(cutoffIso) as Array<{ id: string; root_id: string; type: string }>

  if (rows.length === 0) return { blocks: 0, revisions: 0, docSnapshots: 0 }
  const ids = rows.map((r) => r.id)
  const docRootIds = rows.filter((r) => r.type === 'document').map((r) => r.id)

  // feed 抑制：guard 行存在即可（trigger 的 WHEN 子句据此静默），批间不删除
  db.query('INSERT OR REPLACE INTO sync_consume_guard (id) VALUES (1)').run()
  try {
    let revisions = 0
    let docSnapshots = 0
    // 修订历史：每批独立事务
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const ph = chunk.map(() => '?').join(',')
      revisions += db.transaction(() =>
        db.query(`DELETE FROM block_revisions WHERE block_id IN (${ph})`).run(...(chunk as [string, ...string[]])),
      )().changes
    }
    for (let i = 0; i < docRootIds.length; i += 500) {
      const chunk = docRootIds.slice(i, i + 500)
      const ph = chunk.map(() => '?').join(',')
      docSnapshots += db.transaction(() =>
        db.query(`DELETE FROM doc_snapshots WHERE doc_id IN (${ph})`).run(...(chunk as [string, ...string[]])),
      )().changes
    }
    // 物理删除：每批独立事务（批间释放写锁）
    let blocks = 0
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const ph = chunk.map(() => '?').join(',')
      db.transaction(() => {
        db.query(`DELETE FROM blocks WHERE id IN (${ph})`).run(...(chunk as [string, ...string[]]))
      })()
      blocks += chunk.length
    }
    return { blocks, revisions, docSnapshots }
  } finally {
    db.query('DELETE FROM sync_consume_guard').run()
  }
}

/** 单圈维护：可重复调用；异常上抛由调用方兜底（循环不终止） */
export function runMaintenancePass(): MaintenanceResult {
  const db = getDb()
  let tombstones: TombstonePurgeResult = { blocks: 0, revisions: 0, docSnapshots: 0 }
  let feedRows = 0
  let vecGenerations = 0

  // 批间提交清理（guard 由 batched 内部管理）：大库清理时每 500 批释放写锁，
  // 用户突然活跃的写操作可以插进来，不会堵到整个清理结束
  tombstones = purgeExpiredTombstonesBatched(db, sqlCutoff(TOMBSTONE_RETENTION_MS))

  // 同步已配置时 feed 归 compaction 管；未配置时时间裁剪防单调膨胀
  if (!isProtocolConfigured()) {
    const pruned = pruneStaleChanges(
      db,
      sqlCutoff(FEED_RETENTION_MS),
      protocolStatus().state.publishedSeq,
    )
    if (pruned > 0) {
      noteFeedPruned()
      feedRows = pruned
    }
  }

  vecGenerations = dropStaleVectorGenerations()
  return { tombstones, feedRows, vecGenerations }
}

/** 顶层孤儿 tombstone：超期（维护会物理删）vs 保留期内（满 30 天才清） */
export function countOrphanTombstones(db: ReturnType<typeof getDb>): {
  total: number
  purgeable: number
  retained: number
} {
  const cutoff = sqlCutoff(TOMBSTONE_RETENTION_MS)
  const row = db.query(`
    SELECT
      count(*) AS total,
      coalesce(sum(CASE WHEN b.updated_at < ? THEN 1 ELSE 0 END), 0) AS purgeable
    FROM blocks b
    WHERE b.is_deleted = 1
      AND NOT EXISTS (SELECT 1 FROM blocks p WHERE p.id = b.parent_id AND p.is_deleted = 1)
      AND NOT EXISTS (SELECT 1 FROM blocks c WHERE c.parent_id = b.id AND c.is_deleted = 0)
  `).get(cutoff) as { total: number; purgeable: number }
  const total = Number(row.total) || 0
  const purgeable = Number(row.purgeable) || 0
  return { total, purgeable, retained: total - purgeable }
}

/**
 * 启动维护循环（进程级常驻）：自重排单循环，首跑延迟 5 分钟（避开启动期
 * 索引/同步作业），之后每 6 小时一圈；任何瞬时失败只记日志不终止循环。
 */
export function startMaintenance(): void {
  const tick = async () => {
    const startedAt = Date.now()
    // 空闲感知：用户活跃（最近 10 分钟内有过请求）时跳过本轮，避免大事务卡住读写。
    // 跳过也记一次 info 日志（用户可在维护页看到「已跳过」而非黑盒）。
    if (!isIdleEnoughForMaintenance(IDLE_REQUIRED_MS)) {
      logAppEvent({
        level: 'info',
        source: 'maintenance',
        message: 'maintenance_skipped_active',
        fields: { idleMs: 0, reason: 'recent_api_activity' },
      })
      setTimeout(() => { void tick() }, RUN_INTERVAL_MS)
      return
    }
    try {
      const r = runMaintenancePass()
      const { blocks, revisions, docSnapshots } = r.tombstones
      const durationMs = Date.now() - startedAt
      if (blocks > 0 || r.feedRows > 0 || r.vecGenerations > 0) {
        console.log(
          `🧹 [maintenance] tombstone=${blocks}(rev=${revisions}, snap=${docSnapshots}) `
          + `feed=${r.feedRows} vecGen=${r.vecGenerations}`,
        )
      }
      // 维护结果落库：用户侧「设置 → 维护」可见（不再黑盒）
      logAppEvent({
        level: 'info',
        source: 'maintenance',
        message: 'maintenance_pass',
        fields: { durationMs, tombstoneBlocks: blocks, revisions, docSnapshots, feedRows: r.feedRows, vecGenerations: r.vecGenerations },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn('[maintenance] pass failed:', msg)
      logAppEvent({
        level: 'error',
        source: 'maintenance',
        message: 'maintenance_pass_failed',
        fields: { durationMs: Date.now() - startedAt, error: msg },
      })
    }
    setTimeout(() => { void tick() }, RUN_INTERVAL_MS)
  }
  setTimeout(() => { void tick() }, FIRST_RUN_DELAY_MS)
}
