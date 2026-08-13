/**
 * 同步协议数据面 v2（多端同步：Server 与客户端是对等写入者，共享同一份对象存储）
 *
 * publish（本端 → 存储）：把本地 entity_changes 增量导出为 changes/<device_id>/
 * 分段 jsonl（seq 是设备本地序号，段按发布端 device_id 分桶，两个写端互不覆盖）；
 * 定期生成全量 snapshot.db + snapshot.meta.json（per-device 锚点）。
 * consume（存储 → 本端）：按段所属设备的 per-device 高水位跳过已消费段，
 * 增量按 updated_at LWW 裁决后 upsert / tombstone 进本地库；本端自己的段不消费。
 *
 * 设计：
 * - 增量行 = 变更事件 + 变更后块状态（entity_changes 不存内容，重放需块内容）
 * - 合并直写 SQL（不经 store hooks——索引 / AutoLink / 同步调度由 consume 后显式补齐，
 *   删除级联在 consume 内显式执行）；注意 change feed 是 blocks 表 trigger 驱动，
 *   raw SQL 同样会写 entity_changes——consume 临界区经 sync_consume_guard 行 +
 *   trigger WHEN 子句抑制，消费不产生回波（见 migrations/014）
 * - 存储操作经注入 ObjectStore（与备份 / media 共用抽象层）
 * - v1 布局（段无设备分桶 + 单一全局游标）只在单写端下成立：多写端时高 seq 端的
 *   水位会整段跳过低 seq 端的段，且相同区间的段 key 互相覆盖，均静默丢数据。
 *   detectLayout 识别 v1，migrateV1Layout 自动迁移（LWW 幂等合并旧段/旧快照 →
 *   清理 v1 对象），调用方随后重建 v2 快照与 manifest。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import {
  buildChangesKey,
  buildSnapshotKey,
  buildSnapshotMetaKey,
  buildSnapshotSeqKey,
  buildSyncManifestKey,
  CHANGES_PER_SEGMENT,
  SYNC_S3_DIR,
  type SyncBlockState,
  type SyncChange,
  type SyncManifest,
  type SyncSnapshotMeta,
} from '@notefast/core'
import type { getDb } from '../db'
import { listChanges, getChangesAnchor, pruneChanges, runFeedSuppressed } from '../store/changeFeed'
import { nowTimestamp } from '../store/blocks'
import { deleteRefsTouchingBlocks } from '../store/refs'
import { deleteMentionsTouchingBlocks } from '../store/entities'
import { createLocalSnapshot, verifySnapshotFile } from '../backup/snapshot'
import { durableReplaceFile } from '../backup/durableFs'
import { getObjectText, type ObjectStore } from '../storage/objectStore'

export type Db = ReturnType<typeof getDb>

/** 本地同步状态（data/sync-state.json）：游标为 per-device 高水位 */
export interface SyncState {
  /** 上次已发布的本端 seq（不含） */
  publishedSeq: number
  /** 各远端设备已消费的 seq 高水位（不含；本端自己的 namespace 不消费） */
  consumed: Record<string, number>
}

export interface ConsumeChangesResult {
  applied: number
  skipped: number
  /** 合并后的 per-device 高水位全量（调用方整体替换本地 state.consumed） */
  watermarks: Record<string, number>
  /** 消费触活的文档根 id（调用方据此补语义索引 / AutoLink） */
  docIds: string[]
}

export interface MigrateV1Result {
  applied: number
  skipped: number
  /** 从 v1 段行内 device_id 推导的 per-device 高水位（无 device_id 的行归 'legacy' 桶） */
  watermarks: Record<string, number>
  docIds: string[]
}

/** 存储布局版本判定：v1 = manifest.version 1 或存在未分设备的根级段 */
export type SyncLayout = 'v2' | 'v1' | 'empty'

// ───────────────────── 对象操作（注入 store）─────────────────────

async function getText(store: ObjectStore, key: string): Promise<string | null> {
  return getObjectText(store, key)
}

/** 块 upsert（消费/迁移共用；is_deleted 按 excluded 透传） */
const UPSERT_BLOCK_SQL = `
  INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, tags, status, ai_exclude, sort, level, is_deleted, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    notebook_id = excluded.notebook_id,
    parent_id = excluded.parent_id,
    root_id = excluded.root_id,
    type = excluded.type,
    content = excluded.content,
    properties = excluded.properties,
    tags = excluded.tags,
    status = excluded.status,
    ai_exclude = excluded.ai_exclude,
    sort = excluded.sort,
    level = excluded.level,
    is_deleted = excluded.is_deleted,
    updated_at = excluded.updated_at
`

// ───────────────────── 布局检测（v1 → v2 迁移入口）─────────────────────

/**
 * 判定远端存储布局版本：
 * - manifest.version === 1 → v1
 * - 存在未分设备的根级段 changes/{start}-{end}.jsonl → v1（兼容 manifest 缺失/被并发写丢）
 * - 否则有 manifest(v2) 或设备分桶段 → v2；全无 → empty
 */
export async function detectLayout(store: ObjectStore, prefix: string): Promise<SyncLayout> {
  const text = await getText(store, buildSyncManifestKey(prefix))
  let manifestVersion: number | null = null
  if (text) {
    try {
      const m = JSON.parse(text) as { app?: string; kind?: string; version?: number }
      if (m?.app === 'notefast' && m?.kind === 'sync' && typeof m.version === 'number') {
        manifestVersion = m.version
      }
    } catch { /* 损坏按无 manifest 处理 */ }
  }
  if (manifestVersion === 1) return 'v1'
  const changesPrefix = `${prefix}${SYNC_S3_DIR}/changes/`
  const keys = await store.listObjects(changesPrefix)
  for (const key of keys) {
    // 根级数字段（无设备目录）= v1 段；v2 段余下部分必为 <device_id>/<file>
    if (/^\d+-\d+\.jsonl$/.test(key.slice(changesPrefix.length))) return 'v1'
  }
  if (manifestVersion === 2 || keys.length > 0) return 'v2'
  return 'empty'
}

// ───────────────────── 快照（全量基线）─────────────────────

/**
 * 生成全量快照并上传（VACUUM INTO → snapshot.db + snapshot.meta.json）。
 * 锚点 = 快照内容真实覆盖：{ 本端 device: 本地锚点, ...各远端已消费水位 }。
 * 绝不虚报（虚报会让消费端跳过未合并的段）；回退无害（LWW 幂等重放）。
 * 返回锚点表（供 compactChanges / manifest 复用）。
 */
export async function publishSnapshot(
  db: Db,
  store: ObjectStore,
  prefix: string,
  workDir: string,
  deviceId: string,
  consumed: Record<string, number>,
): Promise<Record<string, number>> {
  const anchors: Record<string, number> = { ...consumed, [deviceId]: getChangesAnchor(db) }
  const snap = await createLocalSnapshot(workDir)
  await store.putObject(buildSnapshotKey(prefix), readFileSync(snap.path))
  const meta: SyncSnapshotMeta = {
    version: 2,
    created_by: deviceId,
    created_at: new Date().toISOString(),
    anchors,
  }
  await store.putObject(buildSnapshotMetaKey(prefix), JSON.stringify(meta))
  return anchors
}

// ───────────────────── 发布（本端 → 存储）─────────────────────

/**
 * 发布增量：把 [publishedSeq, anchor] 区间导出为 changes/<deviceId>/ 分段 jsonl。
 * 每段 CHANGES_PER_SEGMENT 条；追加 = 写新对象（文件名含本端 seq 区间，namespace 内唯一）。
 * 每条变更带发布端 device_id（自持身份，供审计与设备集合推导）。
 * 返回新锚点（应写回本地 state.publishedSeq）。
 */
export async function publishChanges(
  db: Db,
  store: ObjectStore,
  prefix: string,
  publishedSeq: number,
  deviceId: string,
): Promise<number> {
  const anchor = getChangesAnchor(db)
  if (anchor <= publishedSeq) return publishedSeq

  let seq = publishedSeq
  while (seq < anchor) {
    const rows = listChanges(db, { sinceSeq: seq, limit: CHANGES_PER_SEGMENT })
    if (rows.length === 0) break

    const lines: string[] = []
    for (const r of rows) {
      const { entity_updated_at, ...row } = r
      const change: SyncChange = { ...row, device_id: deviceId }
      // 非 tombstone：附加块当前状态（join blocks；块可能已被软删 → 状态为空则发 tombstone）。
      // ai_exclude 只隔离 AI/MCP，同步必须照常携带——误把隐藏当 erase 会自同步删进回收站。
      if (!r.is_erased) {
        const block = db
          .query('SELECT * FROM blocks WHERE id = ?')
          .get(r.entity_id) as SyncBlockState | undefined
        if (block) {
          change.block = block
        } else {
          change.is_erased = 1
        }
      }
      // tombstone：附带删除事件的发生时间供消费端 LWW（trigger 记录的行 updated_at，
      // 毫秒精度；014 之前的旧行为 NULL，回退 changed_at 秒精度——两者都是事件时间，
      // 绝不能用消费时刻，否则离线批量消费「删除→恢复」会永久停在已删除）
      if (change.is_erased) {
        change.deleted_at = entity_updated_at ?? r.changed_at
      }
      lines.push(JSON.stringify(change))
      seq = r.seq
    }
    const startSeq = rows[0]!.seq
    const endSeq = rows[rows.length - 1]!.seq
    await store.putObject(buildChangesKey(prefix, deviceId, startSeq, endSeq), lines.join('\n'))
  }
  return anchor
}

/**
 * 更新 manifest（v2）：读改写合并，各端只维护自己的 devices 条目。
 * 并发写丢更新只让他端条目提示偏旧——消费端以实际段列表为准，不依赖此表。
 * snapshotAnchors 缺省时保留既有快照锚点（仅 compaction 后由调用方传入新值）。
 */
export async function updateManifest(
  store: ObjectStore,
  prefix: string,
  deviceId: string,
  lastSeq: number,
  snapshotAnchors?: Record<string, number>,
): Promise<SyncManifest> {
  const existing = await readManifest(store, prefix)
  const manifest: SyncManifest = {
    app: 'notefast',
    kind: 'sync',
    version: 2,
    devices: { ...(existing?.devices ?? {}), [deviceId]: lastSeq },
    snapshot: snapshotAnchors ?? existing?.snapshot ?? {},
    updated_at: new Date().toISOString(),
  }
  await store.putObject(buildSyncManifestKey(prefix), JSON.stringify(manifest))
  return manifest
}

/** 读取 v2 manifest（v1 / 损坏 / 缺失一律返回 null，由 detectLayout 先行分流） */
export async function readManifest(store: ObjectStore, prefix: string): Promise<SyncManifest | null> {
  const text = await getText(store, buildSyncManifestKey(prefix))
  if (!text) return null
  try {
    const m = JSON.parse(text) as SyncManifest
    if (m && m.app === 'notefast' && m.kind === 'sync' && m.version === 2) return m
  } catch { /* ignore */ }
  return null
}

// ───────────────────── 消费（存储 → 本端）─────────────────────

/**
 * 全量消费：下载 snapshot.db 重建本地库文件（替换）。超窗/首次用。
 * 返回快照的 per-device 锚点（调用方据此外加增量追加快照之后的段）。
 * 注意：快照剥离了 entity_changes，全量恢复后本端 seq 空间从 0 重启——
 * 调用方必须重置 publishedSeq 并更换 device_id（旧 namespace 的小 seq 已被
 * 各端高水位越过，继续用旧 id 发布会被整段跳过）。
 */
export async function consumeSnapshot(
  store: ObjectStore,
  prefix: string,
  targetDbPath: string,
): Promise<Record<string, number>> {
  let anchors: Record<string, number> = {}
  const metaText = await getText(store, buildSnapshotMetaKey(prefix))
  if (metaText) {
    try {
      const m = JSON.parse(metaText) as SyncSnapshotMeta
      if (m?.version === 2 && m.anchors && typeof m.anchors === 'object') anchors = m.anchors
    } catch { /* 损坏按无锚点处理：水位从 0 全量重放（LWW 幂等） */ }
  }

  const bytes = await store.getObject(buildSnapshotKey(prefix))
  if (!bytes) throw new Error('快照为空或不存在')

  // 临时文件校验后 durable 替换（与 backup restore 同模式）
  const tmp = targetDbPath + '.sync-incoming'
  writeFileSync(tmp, Buffer.from(bytes))
  verifySnapshotFile(tmp)
  durableReplaceFile(tmp, targetDbPath, readFileSync(tmp))
  return anchors
}

/**
 * Compaction：生成新快照（覆盖旧快照）后，删除**本端 namespace** 的旧 changes 段。
 * 不动其他设备的段——它们的段是否已被快照安全覆盖取决于所有端的消费进度，
 * 本端无法证明（那需要全局共识）；各设备的段由各自的 compaction 清理。
 * 同时以本端快照锚点为下界裁剪本地 entity_changes 历史行（pruneChanges）。
 *
 * 已知限制：共享单快照后写覆盖，锚点按「快照内容真实覆盖」写本端视图。若两端
 * 交替 compaction 且未来得及互相消费，后写快照对某设备的锚点可能回退——回退本身
 * 无害（段还在则幂等重放），但若该设备已按自己更高的快照锚点裁掉自己的段，
 * 超窗端将够不到该区间。彻底解需 per-device 快照或共识裁剪，超出本期范围。
 */
export async function compactChanges(
  db: Db,
  store: ObjectStore,
  prefix: string,
  workDir: string,
  deviceId: string,
  consumed: Record<string, number>,
): Promise<{ anchor: number; anchors: Record<string, number> }> {
  // 1) 覆盖新快照（锚点 = 本端视图）
  const anchors = await publishSnapshot(db, store, prefix, workDir, deviceId, consumed)
  const anchor = anchors[deviceId] ?? 0
  // 2) 只删除本端 namespace 的段（快照已兜底本端区间）
  const ownPrefix = `${prefix}${SYNC_S3_DIR}/changes/${deviceId}/`
  const keys = await store.listObjects(ownPrefix)
  if (keys.length > 0) {
    const res = await store.deleteObjects(keys)
    if (res.errors.length > 0) {
      console.warn('[sync] compact 部分删除失败:', res.errors.length, '个')
    }
  }
  // 3) v1 遗留对象顺手清理（v1 段/manifest 由 migrateV1Layout 负责）
  try { await store.deleteObject(buildSnapshotSeqKey(prefix)) } catch { /* 不存在/失败均无碍 */ }
  // 4) 裁剪本地历史行：必须在快照上传成功之后——下界 seq 已被远端快照覆盖，
  //    本地发布（publishedSeq 被调用方重置为该锚点）与消费端都不再需要它们。
  //    锚点为 0（空库快照）时 pruneChanges 内部不裁。
  pruneChanges(db, anchor)
  return { anchor, anchors }
}

/** LWW 裁决：incoming 是否应覆盖本地（本地缺失 → 覆盖；时间更晚 → 覆盖） */
function shouldApply(
  db: Db,
  block: SyncBlockState,
): boolean {
  const local = db.query('SELECT updated_at FROM blocks WHERE id = ?').get(block.id) as
    | { updated_at: string }
    | undefined
  if (!local) return true
  return block.updated_at > local.updated_at
}

/**
 * 消费端删除级联（对齐 store 软删语义：refs/mentions 级联 + afterDelete 的向量清理）。
 * consume 直写 SQL 不经 store/hooks，级联必须显式补齐，否则远端删除的块在本端
 * 留下悬空引用、实体提及与向量残留。
 */
function cascadeConsumedDelete(db: Db, ids: string[]): void {
  deleteRefsTouchingBlocks(db, ids)
  deleteMentionsTouchingBlocks(db, ids)
  deleteConsumedVectors(db, ids)
}

/** 直清块的向量索引底座（block_vectors / vector_entries / vec_blocks_* 三处） */
function deleteConsumedVectors(db: Db, ids: string[]): void {
  if (ids.length === 0) return
  const ph = ids.map(() => '?').join(',')
  const params = ids as [string, ...string[]]
  db.query(`DELETE FROM block_vectors WHERE block_id IN (${ph})`).run(...params)
  const entries = db
    .query(`SELECT id FROM vector_entries WHERE block_id IN (${ph})`)
    .all(...params) as Array<{ id: number }>
  if (entries.length === 0) return
  const entryIds = entries.map((e) => e.id) as [number, ...number[]]
  const eph = entryIds.map(() => '?').join(',')
  // vec 虚拟表需 vec0 已加载才可写；未加载时保留残留——两个后端的检索都显式
  // 过滤 is_deleted = 0，残留不会成为「幽灵命中」（对齐快照剥离的同款兜底）
  const vecTables = db
    .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_blocks\\_%' ESCAPE '\\'`)
    .all() as Array<{ name: string }>
  for (const t of vecTables) {
    try {
      db.query(`DELETE FROM "${t.name}" WHERE rowid IN (${eph})`).run(...entryIds)
    } catch { /* vec0 未加载：跳过该表 */ }
  }
  db.query(`DELETE FROM vector_entries WHERE id IN (${eph})`).run(...entryIds)
}

/**
 * 应用 tombstone。LWW 字段用删除事件的发生时间（deleted_at），绝不用消费时刻——
 * 远端「删除 T1 → 恢复 T2」离线批量消费时，消费时刻 Tc > T2 会让随后的恢复
 * upsert 被 shouldApply 跳过，本端永久停在已删除。返回是否实际应用。
 */
function applyTombstone(db: Db, change: SyncChange): boolean {
  // 旧发布端无 deleted_at：回退 changed_at（事件时间，秒精度，仍早于消费时刻）
  const deletedAt = change.deleted_at ?? change.changed_at
  const local = db
    .query('SELECT updated_at, is_deleted FROM blocks WHERE id = ?')
    .get(change.entity_id) as { updated_at: string; is_deleted: number } | undefined
  if (!local || local.is_deleted === 1) return false // 本地无此行 / 已删：幂等跳过
  if (local.updated_at > deletedAt) return false // 本地状态更晚（如更晚的本地编辑），LWW 保留
  db.query(
    `UPDATE blocks SET is_deleted = 1, delete_id = lower(hex(randomblob(16))), updated_at = ? WHERE id = ?`,
  ).run(deletedAt, change.entity_id)
  cascadeConsumedDelete(db, [change.entity_id])
  return true
}

type UpsertStmt = ReturnType<Db['query']>

/**
 * 应用单行变更（consume / v1 迁移共用）：tombstone 或 LWW upsert。
 * 调用方负责 seq/水位过滤与 guard 事务。
 */
function applyChangeLine(
  db: Db,
  change: SyncChange,
  docIds: Set<string>,
  upsert: UpsertStmt,
): 'applied' | 'skipped' {
  if (change.is_erased) {
    return applyTombstone(db, change) ? 'applied' : 'skipped'
  }
  if (change.block && shouldApply(db, change.block)) {
    const b = change.block
    // is_deleted 按远端状态写入（旧发布端缺省 = 0 活）；「软删块上的非 erase
    // 变更」不再复活块
    const incomingDeleted = (b.is_deleted ?? 0) === 1
    const local = db
      .query('SELECT is_deleted FROM blocks WHERE id = ?')
      .get(b.id) as { is_deleted: number } | undefined
    upsert.run(
      b.id, b.notebook_id, b.parent_id, b.root_id, b.type, b.content,
      b.properties ?? '{}', b.tags ?? '[]', b.status ?? 'note', b.ai_exclude ?? 0,
      b.sort, b.level, incomingDeleted ? 1 : 0, b.created_at ?? nowTimestamp(), b.updated_at,
    )
    if (incomingDeleted) {
      // 本地由活转删：补删除级联
      if (local?.is_deleted === 0) cascadeConsumedDelete(db, [b.id])
    } else {
      docIds.add(b.root_id)
    }
    return 'applied'
  }
  return 'skipped'
}

/**
 * consume 临界区：guard 行 + 单事务应用（一段一次 auto-commit 会 fsync 数百次，
 * 单事务同时解决性能与回波抑制窗口问题）。实现见 store/changeFeed 的
 * runFeedSuppressed——事务内插入 sync_consume_guard 行，blocks 表 trigger 的
 * WHEN 子句据此静默；单线程下本地写入不可能落入该同步临界区被误挡
 * （protocolManager 另有 running 互斥防并发同步轮次）。
 */
function runInConsumeGuard<T>(db: Db, fn: () => T): T {
  return runFeedSuppressed(db, fn)
}

interface FetchedSegment {
  deviceId: string
  startSeq: number
  endSeq: number
  lines: string[]
}

/**
 * 增量合并（v2）：列出 changes/ 下各设备分桶段，跳过本端 namespace，
 * 按各设备高水位过滤后逐行 LWW 裁决 upsert / tombstone。
 *
 * 两阶段：先异步拉取全部段文本（不写库，本地写入不受干扰），再在 guard
 * 同步事务里应用。设备发现以实际段列表为准（manifest.devices 只是提示，
 * 并发写丢更新不影响消费完整性）。
 */
export async function consumeChanges(
  db: Db,
  store: ObjectStore,
  prefix: string,
  consumed: Record<string, number>,
  selfDeviceId: string,
): Promise<ConsumeChangesResult> {
  const changesPrefix = `${prefix}${SYNC_S3_DIR}/changes/`
  const keys = (await store.listObjects(changesPrefix)).sort()

  // 第一阶段（异步）：解析设备分桶段并按各设备水位过滤、拉取文本
  const segments: FetchedSegment[] = []
  for (const key of keys) {
    const rest = key.slice(changesPrefix.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) continue // 根级 v1 段（迁移前不应走到这）或异常对象
    const deviceId = rest.slice(0, slash)
    const m = rest.slice(slash + 1).match(/^(\d+)-(\d+)\.jsonl$/)
    if (!m) continue
    if (deviceId === selfDeviceId) continue // 本端自己的段不消费
    const endSeq = parseInt(m[2]!, 10)
    if (endSeq <= (consumed[deviceId] ?? 0)) continue // 该设备水位已越过
    const text = await getText(store, key)
    if (!text) continue
    segments.push({ deviceId, startSeq: parseInt(m[1]!, 10), endSeq, lines: text.split('\n') })
  }
  // 字典序已保序（device_id / 零填充段名），显式再排一遍防 store 实现差异
  segments.sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.startSeq - b.startSeq)

  // 第二阶段（同步临界区）：guard 行 + 单事务应用
  const watermarks: Record<string, number> = { ...consumed }
  const docIds = new Set<string>()
  let applied = 0
  let skipped = 0
  runInConsumeGuard(db, () => {
    const upsert = db.query(UPSERT_BLOCK_SQL)
    for (const seg of segments) {
      const wm = watermarks[seg.deviceId] ?? 0
      let maxSeq = wm
      for (const line of seg.lines) {
        if (!line.trim()) continue
        let change: SyncChange
        try {
          change = JSON.parse(line) as SyncChange
        } catch { skipped++; continue }
        if (change.seq <= wm) continue
        if (applyChangeLine(db, change, docIds, upsert) === 'applied') applied++
        else skipped++
        if (change.seq > maxSeq) maxSeq = change.seq
      }
      // 段整体消费完（含空行/跳过）：推进到段终点，避免同段重复拉
      watermarks[seg.deviceId] = Math.max(maxSeq, seg.endSeq)
    }
  })

  return { applied, skipped, watermarks, docIds: [...docIds] }
}

// ───────────────────── v1 → v2 迁移 ─────────────────────

/**
 * v1 布局迁移：把旧格式（根级段 + 可选 v1 快照）的内容 LWW 合并进本地库，
 * 从行内 device_id 推导 per-device 高水位，然后删除全部 v1 对象。
 * 调用方随后重建 v2 快照（compactChanges）与 v2 manifest（updateManifest）。
 *
 * 不重放过滤（v1 单一全局游标无法归因到设备）：全量重放靠 LWW 幂等保证无害。
 * v1 段行本就带 device_id（v1 发布端已写入），故水位可精确归因；个别缺省行
 * 归 'legacy' 桶（只影响该桶的重复重放，仍幂等）。
 *
 * 旧端混用说明：迁移后 manifest 为 v2，旧端 readManifest 只认 version 1 →
 * 拉取显式报错（不静默）；但旧端 syncNow 会重写 v1 manifest 并继续写根级段，
 * 本端下轮会再次检测为 v1 并重复迁移（幂等但徒劳）——应尽快升级所有端。
 * 旧端消费 v2 段会按其本地全局水位错误跳过（v1 固有缺陷，新端无法代为修正）。
 */
export async function migrateV1Layout(
  db: Db,
  store: ObjectStore,
  prefix: string,
  workDir: string,
): Promise<MigrateV1Result> {
  const changesPrefix = `${prefix}${SYNC_S3_DIR}/changes/`
  // 1) 拉取 v1 根级段文本与旧快照字节
  const keys = (await store.listObjects(changesPrefix))
    .filter((k) => /^\d+-\d+\.jsonl$/.test(k.slice(changesPrefix.length)))
    .sort()
  const segTexts: string[] = []
  for (const key of keys) {
    const text = await getText(store, key)
    if (text) segTexts.push(text)
  }
  const snapBytes = await store.getObject(buildSnapshotKey(prefix))
  let snapPath: string | null = null
  if (snapBytes) {
    mkdirSync(workDir, { recursive: true })
    snapPath = join(workDir, 'legacy-snapshot.db')
    writeFileSync(snapPath, Buffer.from(snapBytes))
  }

  // 2) 单事务 LWW 合并（guard 抑制回波：迁移不污染本端 change feed）
  const watermarks: Record<string, number> = {}
  const docIds = new Set<string>()
  let applied = 0
  let skipped = 0
  runInConsumeGuard(db, () => {
    const upsert = db.query(UPSERT_BLOCK_SQL)
    // 2a) v1 快照：旧端 compaction 可能已删旧段，快照内容只能从库文件逐行并
    if (snapPath) {
      const snap = new Database(snapPath, { readonly: true })
      try {
        const rows = snap.query('SELECT * FROM blocks').all() as SyncBlockState[]
        for (const row of rows) {
          const deleted = (row.is_deleted ?? 0) === 1
          const pseudo: SyncChange = {
            seq: 0,
            entity: 'block',
            entity_id: row.id,
            is_erased: deleted ? 1 : 0,
            actor: 'v1-snapshot',
            changed_at: row.updated_at,
            // 快照软删行按 tombstone 处理，删除时间用行 updated_at（事件时间）
            deleted_at: deleted ? row.updated_at : undefined,
            block: deleted ? undefined : row,
          }
          if (applyChangeLine(db, pseudo, docIds, upsert) === 'applied') applied++
          else skipped++
        }
      } finally {
        snap.close()
      }
    }
    // 2b) v1 段：逐行 LWW 重放，同时按行内 device_id 推导 per-device 高水位
    for (const text of segTexts) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let change: SyncChange
        try {
          change = JSON.parse(line) as SyncChange
        } catch { skipped++; continue }
        if (applyChangeLine(db, change, docIds, upsert) === 'applied') applied++
        else skipped++
        const dev = change.device_id ?? 'legacy'
        if (change.seq > (watermarks[dev] ?? 0)) watermarks[dev] = change.seq
      }
    }
  })

  // 3) 清理 v1 对象（内容已合并；v2 快照/manifest 由调用方随后重建，旧 manifest
  //    不删会被 detectLayout 反复判成 v1）
  const legacyKeys = [...keys, buildSnapshotSeqKey(prefix), buildSyncManifestKey(prefix)]
  if (snapBytes) legacyKeys.push(buildSnapshotKey(prefix))
  const res = await store.deleteObjects(legacyKeys)
  if (res.errors.length > 0) {
    console.warn('[sync] v1 迁移清理部分失败:', res.errors.length, '个')
  }
  return { applied, skipped, watermarks, docIds: [...docIds] }
}
