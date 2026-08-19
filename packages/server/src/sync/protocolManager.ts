/**
 * 同步协议 Manager（方案 A：客户端与 Web 共享同一份 S3，对等写入者）
 *
 * 与 sync/manager.ts（单向 Markdown 归档）独立：这里是双向增量同步。
 * - 配置复用 backup 的 S3 凭据（同一份库的身份 = 存储位置 + 凭据），
 *   同步用独立前缀 {prefix}sync/，不新增配置维度
 * - state 持久化到 data/sync-state.json（publishedSeq + per-device consumed 高水位）
 * - syncNow() = 布局检测（v1 自动迁移）→ publish → 定期 compaction → 更新 manifest
 * - 消费游标为 per-device 高水位：远端各设备独立推进，本端 namespace 不消费
 *
 * 编排注意：publish 和 consume 在同一前缀，本端只发布自己的 namespace、
 * 只消费他端的 namespace，天然无自回环。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { createS3ObjectStore, getObjectText, type ObjectStore } from '../storage/objectStore'
import { initDb, closeDb, getDb, getDbPath } from '../db'
import { collectReferencedAssetIds, getMediaDir } from '../assets/store'
import { restoreReferencedMedia, uploadMissingMedia, mediaPrefixFor } from '../backup/mediaBackup'
import {
  applyProtocolConfig,
  disableProtocolConfig,
  getProtocolConfig,
  initProtocolConfig,
  _resetProtocolConfigForTests,
} from './protocolConfig'
import {
  SYNC_S3_DIR,
  type S3LocationConfig,
  type StorageLocation,
  type SyncDevice,
  type SyncProtocolConfigInput,
} from '@notefast/core'
import { getStorageLocation } from '../storage/locations'
import {
  publishChanges,
  consumeChanges,
  consumeSnapshot,
  compactChanges,
  detectLayout,
  migrateV1Layout,
  readManifest,
  updateManifest,
} from './protocol'
import { getChangesAnchor } from '../store/changeFeed'
import { fetchDocBlockIds, getDocById } from '../store/blocks'
import { scheduleDocIndex } from '../ai/indexJobs'
import { reanalyzeDoc } from '../ai/autoLink'

const STATE_FILE = 'sync-state.json'
const DEVICE_ID_FILE = 'device.id'
/** 每 N 次同步生成一次快照（compaction 兜底阈值） */
const SNAPSHOT_EVERY_N = 10

export interface SyncProtocolState {
  /** 上次已发布到 S3 的本端 seq（不含；下一轮从此导出） */
  publishedSeq: number
  /** 各远端设备已消费的 seq 高水位（不含；per-device，v2 起替代单一 consumedSeq） */
  consumed: Record<string, number>
  /** 自上次快照以来累计的同步轮数（触发 compaction） */
  sinceSnapshot: number
  /** 本地 change feed 曾被时间裁剪过（未配置同步期间的维护任务）：下次启用同步
   *  且远端为空时，首轮必须立即生成快照让新端走全量，防「从残缺增量补齐」漏块 */
  feedPruned: boolean
}

export interface SyncProtocolStatus {
  configured: boolean
  enabled: boolean
  s3Bucket?: string
  s3Prefix?: string
  lastRunAt?: string
  lastSuccessAt?: string
  lastError?: string
  state: SyncProtocolState
  /** 本地待发布变更条数（entity_changes 锚点 - publishedSeq；>0 说明还有未同步的本地改动） */
  pendingChanges: number
  running: boolean
  /** per-device 远端视图（最近一次同步读到的 manifest.devices × 本端消费水位） */
  details?: {
    remoteDevices: Array<{ deviceId: string; lastSeq: number; consumedSeq: number }>
  }
}

let dataDir = ''
let store: ObjectStore | null = null
/** 当前 store 对应的 S3 配置指纹（懒重建判断用） */
let storeFingerprint = ''
let running = false
let lastRunAt: string | null = null
let lastSuccessAt: string | null = null
let lastError: string | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let heartbeatBusy = false
let state: SyncProtocolState = { publishedSeq: 0, consumed: {}, sinceSnapshot: 0, feedPruned: false }
/** 最近一次同步读到的远端 manifest.devices（状态面板 per-device 展示用） */
let lastRemoteDevices: Record<string, number> | null = null
/** 当前 seq 锚点所属的 S3 位置指纹（bucket/endpoint/region/prefix）；位置变化时重置游标 */
let stateLocation = ''
/** 编辑后去抖同步定时器（合并多次写入为一次同步） */
let debounceTimer: ReturnType<typeof setTimeout> | null = null
/** 去抖窗口：写入后延迟触发，期间多次写入合并为一次 */
const SYNC_DEBOUNCE_MS = 5_000
/** 固定心跳：多端收敛 + 兜底推送（不可配置，完全自动） */
const SYNC_HEARTBEAT_MS = 60_000

/** 启动期初始化（dataDir + 独立的多端同步 S3 配置） */
export function initProtocolManager(dir: string): void {
  dataDir = dir
  state = loadState()
  initProtocolConfig(dir)
  rebuild()
}

/** 是否已配置（引用了存储连接且已启用） */
export function isProtocolConfigured(): boolean {
  const c = getProtocolConfig()
  return Boolean(c.enabled && c.locationId)
}

export function protocolStatus(): SyncProtocolStatus {
  const c = getProtocolConfig()
  const loc = c.locationId ? getStorageLocation(c.locationId) : undefined
  // 懒重建：配置可在运行期（多端同步面板）更新，而 store 只在 init 时创建。
  // 配置已就绪但 store 未建、或连接/前缀指纹变化时自动重建，否则同步永远「未配置」或用着旧连接。
  const prefix = c.prefix ?? ''
  const fingerprint = loc?.s3 ? s3Fingerprint(loc.s3, prefix) : ''
  if (isProtocolConfigured() && (!store || storeFingerprint !== fingerprint)) {
    rebuild()
    storeFingerprint = store ? fingerprint : ''
  }
  return {
    configured: isProtocolConfigured(),
    enabled: Boolean(store),
    s3Bucket: loc?.s3?.bucket,
    s3Prefix: c.prefix,
    lastRunAt: lastRunAt ?? undefined,
    lastSuccessAt: lastSuccessAt ?? undefined,
    lastError: lastError ?? undefined,
    state,
    pendingChanges: pendingChangeCount(),
    running,
    details: lastRemoteDevices
      ? {
          remoteDevices: Object.entries(lastRemoteDevices).map(([deviceId, lastSeq]) => ({
            deviceId,
            lastSeq,
            consumedSeq: state.consumed[deviceId] ?? 0,
          })),
        }
      : undefined,
  }
}

/** 本地待发布变更条数（change feed 锚点 - 已发布；db 不可用/未初始化时按 0 处理） */
function pendingChangeCount(): number {
  try {
    return Math.max(0, getChangesAnchor(getDb()) - state.publishedSeq)
  } catch {
    return 0
  }
}

/** 热重载：更新独立配置（脱敏密钥沿用旧值），重建 store 与心跳 */
export async function applyProtocolManagerConfig(incoming: SyncProtocolConfigInput): Promise<SyncProtocolStatus> {
  applyProtocolConfig(incoming)
  rebuild()
  return protocolStatus()
}

/** 停用多端同步（保留已填 S3，方便重新启用） */
export async function disableProtocolManager(): Promise<SyncProtocolStatus> {
  disableProtocolConfig()
  rebuild()
  return protocolStatus()
}

function ensureWorkRoot(): string {
  const workRoot = join(dataDir, '.sync-tmp')
  if (!existsSync(workRoot)) mkdirSync(workRoot, { recursive: true })
  return workRoot
}

/**
 * v1 → v2 自动迁移（对齐「换存储位置指纹重置游标」先例：宁可全量重建，不静默漏数据）：
 * LWW 合并 v1 段/旧快照（幂等）→ 推导 per-device 水位 → 重建 v2 快照与 manifest。
 * 旧端混用时它会把 manifest 写回 v1 并继续写根级段——本端下轮会再次迁移（幂等但
 * 徒劳），且旧端消费 v2 段会按其全局水位错误跳过（v1 固有缺陷），应尽快升级所有端。
 */
async function migrateToV2(db: ReturnType<typeof getDb>, store: ObjectStore, prefix: string, workRoot: string): Promise<void> {
  console.warn('[sync] 检测到 v1 同步布局（旧版单写端格式），自动迁移到 v2（per-device 段 + 高水位）；请尽快升级所有同步端')
  const r = await migrateV1Layout(db, store, prefix, join(workRoot, `migrate-${Date.now()}`))
  for (const [d, s] of Object.entries(r.watermarks)) {
    state.consumed[d] = Math.max(state.consumed[d] ?? 0, s)
  }
  // 重建 v2 快照（含刚合并的 v1 内容）+ v2 manifest
  const { anchor, anchors } = await compactChanges(db, store, prefix, workRoot, getDeviceId(), state.consumed)
  state.publishedSeq = anchor
  state.sinceSnapshot = 0
  const manifest = await updateManifest(store, prefix, getDeviceId(), anchor, anchors)
  lastRemoteDevices = manifest.devices
  scheduleConsumeFollowUp(r.docIds)
  saveState()
  console.warn(`[sync] v1 → v2 迁移完成（合并 ${r.applied} 条，跳过 ${r.skipped} 条）`)
}

/**
 * 执行一轮同步（发布端语义）：布局检测 → 发布本地增量 → 定期快照（compaction）→ 更新 manifest。
 */
export async function syncNow(): Promise<{ published: number; snapshotCreated: boolean; state: SyncProtocolState }> {
  if (!store) {
    throw Object.assign(new Error('多端同步未配置（S3 未配置或未启用）'), { code: 'not_configured' })
  }
  if (running) {
    throw Object.assign(new Error('同步进行中'), { code: 'sync_in_progress' })
  }
  running = true
  lastRunAt = new Date().toISOString()
  try {
    const db = getDb()
    const c = getProtocolConfig()
    resolvedS3() // 校验连接可用
    const prefix = syncPrefix(c.prefix)
    const workRoot = ensureWorkRoot()

    // 0) 布局检测：v1 先迁移（合并旧内容 + 重建 v2 快照/manifest），再正常发布。
    //    远端为空且本端 feed 曾被时间裁剪（从未发布）：立即生成快照并推进
    //    publishedSeq 到锚点——否则新端从残缺增量补齐会静默漏掉被裁掉的行
    let forceSnapshot: { anchor: number; anchors: Record<string, number> } | null = null
    const layout = await detectLayout(store, prefix)
    if (layout === 'v1') {
      await migrateToV2(db, store, prefix, workRoot)
    } else if (layout === 'empty' && state.feedPruned && state.publishedSeq === 0) {
      forceSnapshot = await compactChanges(db, store, prefix, workRoot, getDeviceId(), state.consumed)
      state.publishedSeq = forceSnapshot.anchor
      state.sinceSnapshot = 0
      state.feedPruned = false
      console.warn('[sync] 本地变更日志曾被时间裁剪：首次启用已立即生成全量快照（新端走全量同步）')
    }

    // 1) 发布本地增量（本端 namespace：changes/<device_id>/；每条变更带 device_id）
    const prevPublishedSeq = state.publishedSeq
    const newPublished = await publishChanges(db, store, prefix, state.publishedSeq, getDeviceId())

    // 2) media 上送：让同步位置自包含（内容寻址增量幂等；失败不阻断变更发布）
    const mediaDir = getMediaDir()
    if (mediaDir) {
      try {
        await uploadMissingMedia(store, mediaPrefixFor(c.prefix), mediaDir)
      } catch (e) {
        console.warn('[sync] media 上送失败（变更仍发布）:', e instanceof Error ? e.message : e)
      }
    }

    // 3) 设备注册上报（每设备一对象，无并发写冲突；失败不阻断）
    try {
      await updateDeviceRegistry(store, prefix)
    } catch (e) {
      console.warn('[sync] 设备注册上报失败:', e instanceof Error ? e.message : e)
    }

    const published = Math.max(0, newPublished - prevPublishedSeq)
    // 4) compaction 触发：仅当本轮实际发布了变更才累计轮次。
    //    空转心跳不计 —— 否则每 ~10 分钟无条件 VACUUM INTO 全库快照。
    let snapshotCreated = false
    let snapAnchors: Record<string, number> | undefined = forceSnapshot?.anchors
    if (forceSnapshot) {
      snapshotCreated = true
    } else if (published > 0) {
      state.sinceSnapshot += 1
      if (state.sinceSnapshot >= SNAPSHOT_EVERY_N) {
        const r = await compactChanges(db, store, prefix, workRoot, getDeviceId(), state.consumed)
        snapAnchors = r.anchors
        state.sinceSnapshot = 0
        snapshotCreated = true
      }
    }

    // 5) 更新 manifest（维护自己的 devices 条目；compaction 后同步快照锚点副本）
    const manifest = await updateManifest(store, prefix, getDeviceId(), newPublished, snapAnchors)
    lastRemoteDevices = manifest.devices

    // compact 后旧增量已删，publishedSeq 推到快照锚点（快照已涵盖，无需再导出）；
    // 未 compact 时推到本次发布锚点
    state.publishedSeq = snapshotCreated ? (snapAnchors?.[getDeviceId()] ?? newPublished) : newPublished
    saveState()
    lastSuccessAt = lastRunAt
    lastError = null
    return { published, snapshotCreated, state }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    running = false
  }
}

/**
 * 消费端拉取（客户端「从 S3 恢复到本地」的入口）：
 * 1. 布局检测（v1 先迁移）→ 读 manifest，按快照锚点判断是否需要全量
 * 2. 全量：任一设备快照锚点 > 本端对应水位 → closeDb + consumeSnapshot 重建库文件
 *    → 重新 initDb → 水位 = 快照锚点；快照剥离 entity_changes，本地 seq 空间从 0
 *    重启，故 publishedSeq 归零并更换 device_id（旧 namespace 的小 seq 已被各端
 *    高水位越过，继续用旧 id 发布会被整段跳过）
 * 3. 增量（全量后同样执行）：consumeChanges 追加快照之后的段 → media 拉回
 * 4. 持久化 state
 *
 * 语义：消费端在**独立进程/客户端**跑；server 内调用时，全量路径会 closeDb（库文件被替换，
 * 本地未发布改动随之丢失），调用方需理解这是「恢复到本地」而非「服务端自合并」。
 */
export async function syncPull(): Promise<{ mode: 'full' | 'incremental'; applied: number; mediaRestored: number; state: SyncProtocolState }> {
  if (!store) {
    throw Object.assign(new Error('多端同步未配置（S3 未配置或未启用）'), { code: 'not_configured' })
  }
  if (running) {
    throw Object.assign(new Error('同步进行中'), { code: 'sync_in_progress' })
  }
  running = true
  lastRunAt = new Date().toISOString()
  try {
    const c = getProtocolConfig()
    resolvedS3()
    const prefix = syncPrefix(c.prefix)
    const workRoot = ensureWorkRoot()

    if ((await detectLayout(store, prefix)) === 'v1') {
      await migrateToV2(getDb(), store, prefix, workRoot)
    }
    const manifest = await readManifest(store, prefix)
    if (!manifest) {
      throw Object.assign(new Error('远端无同步数据（manifest 不存在）'), { code: 'no_remote' })
    }
    lastRemoteDevices = manifest.devices
    const anchors = manifest.snapshot ?? {}
    // 任一设备快照锚点超过本端水位 = 增量可能已被 compaction 清理 → 全量重建
    const needFull = Object.entries(anchors).some(([d, s]) => s > (state.consumed[d] ?? 0))

    let mode: 'full' | 'incremental' = 'incremental'
    if (needFull) {
      mode = 'full'
      const target = getDbPath()
      try { closeDb() } catch { /* 未打开也 OK */ }
      const snapAnchors = await consumeSnapshot(store, prefix, target)
      // 重新打开库（读引用集合 / 后续使用）
      initDb(dataDir)
      state.consumed = { ...snapAnchors }
      state.publishedSeq = 0
      regenerateDeviceId()
    }

    // 增量追加快照之后的段（全量模式同样需要：快照之后他端可能又发布了新段）
    const consumed = await consumeChanges(getDb(), store, prefix, state.consumed, getDeviceId())
    state.consumed = consumed.watermarks
    scheduleConsumeFollowUp(consumed.docIds)

    // media 拉回（引用集合；内容寻址跳过已有，成本低）
    let mediaRestored = 0
    const mediaDir = getMediaDir()
    if (mediaDir) {
      const refs = collectReferencedAssetIds()
      if (refs.size > 0) {
        const mediaRes = await restoreReferencedMedia(store, mediaPrefixFor(c.prefix), mediaDir, refs)
        mediaRestored = mediaRes.restored
      }
    }

    saveState()
    lastSuccessAt = lastRunAt
    lastError = null
    return { mode, applied: consumed.applied, mediaRestored, state }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    running = false
  }
}

function startHeartbeat(): void {
  stopHeartbeat()
  if (!store) return
  heartbeatTimer = setInterval(() => {
    syncHeartbeat().catch((err) => {
      const code = (err as { code?: string }).code
      if (code !== 'sync_in_progress' && code !== 'not_configured') {
        console.warn('[sync-protocol] heartbeat failed:', err instanceof Error ? err.message : err)
      }
    })
  }, SYNC_HEARTBEAT_MS)
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

/**
 * 固定心跳：推送本地变更 + 增量合并远端变更（不全量恢复自身）。
 * 多端收敛与兜底推送；无变更时 publish 早退、consume 按各设备水位跳过，成本可忽略。
 */
async function syncHeartbeat(): Promise<void> {
  if (heartbeatBusy || running || !store) return
  heartbeatBusy = true
  try {
    await syncNow()
    await safeMergeRemote()
  } finally {
    heartbeatBusy = false
  }
}

/**
 * 增量消费后的 AI 补齐（对照回收站恢复路径先例 api/blocks.ts restore）：
 * 远端同步来的内容在本端语义检索里是「哑」的——向量未建立、实体与链未抽取。
 * 按文档根调度重索引 + AutoLink 重分析。无 provider / autoIndex / autoLink 关闭时
 * scheduleDocIndex / reanalyzeDoc 安全 no-op。
 * 无循环：二者只写 block_vectors / block_refs / entity_mentions，不触碰 blocks
 * （不进 change feed），也不调 scheduleSyncNow。
 */
function scheduleConsumeFollowUp(docIds: string[]): void {
  if (docIds.length === 0) return
  const db = getDb()
  for (const docId of docIds) {
    const doc = getDocById(db, docId)
    // inbox / archived / ai_exclude 文档不参与索引与建链（对齐 hooks 过滤语义）
    if (!doc || doc.status !== 'note' || doc.ai_exclude) continue
    scheduleDocIndex(docId, fetchDocBlockIds(db, docId))
    reanalyzeDoc(docId)
  }
}

/** 服务端安全合并远端变更：任一设备落后于快照锚点时不恢复自身（保持权威，交给客户端全量拉取） */
async function safeMergeRemote(): Promise<void> {
  if (!store) return
  resolvedS3()
  const prefix = syncPrefix(getProtocolConfig().prefix)
  const manifest = await readManifest(store, prefix)
  // null = 远端为空或仍是 v1 布局（v1 由 syncNow 路径迁移；心跳先 syncNow 后到这里）
  if (!manifest) return
  lastRemoteDevices = manifest.devices
  const anchors = manifest.snapshot ?? {}
  const behind = Object.entries(anchors).some(([d, s]) => s > (state.consumed[d] ?? 0))
  if (behind) return
  const consumed = await consumeChanges(getDb(), store, prefix, state.consumed, getDeviceId())
  const changed = Object.entries(consumed.watermarks).some(([d, s]) => s !== (state.consumed[d] ?? 0))
  if (changed) {
    state.consumed = consumed.watermarks
    saveState()
  }
  scheduleConsumeFollowUp(consumed.docIds)
}

/**
 * 编辑后去抖自动同步（fire-and-forget）：
 * 文档写入等变更后调用，延迟 SYNC_DEBOUNCE_MS 触发一次 syncNow；
 * 窗口内多次写入合并为一次。未配置 S3 时静默跳过（不打扰用户）。
 * 不阻塞写入响应；syncNow 的 running 互斥天然防重叠。
 */
export function scheduleSyncNow(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (!store) return // 未配置同步：静默跳过
    syncNow().catch((err) => {
      const code = (err as { code?: string }).code
      if (code !== 'sync_in_progress' && code !== 'not_configured') {
        console.warn('[sync-protocol] debounced sync failed:', err instanceof Error ? err.message : err)
      }
    })
  }, SYNC_DEBOUNCE_MS)
}

function stopDebounceTimer(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

/**
 * 标记本地 change feed 已被时间裁剪（维护任务在未配置同步期间的清理）。
 * syncNow 首轮据此在「远端为空且从未发布」时立即生成快照——远端新设备
 * 走全量同步而非残缺增量（时间裁剪丢掉的早期行会让增量消费漏块）。
 */
export function noteFeedPruned(): void {
  if (state.feedPruned) return
  state.feedPruned = true
  saveState()
}

// ───────────────────── 内部 ─────────────────────

/** S3 连接指纹：连接 id + bucket/endpoint/region/凭据/前缀任一变化 → 指纹变 → 重建 store */
function s3Fingerprint(s3: S3LocationConfig, prefix: string): string {
  return [s3.bucket, s3.endpoint, s3.region, s3.accessKeyId, s3.secretAccessKey, prefix].join('|')
}

/** S3 位置指纹（不含凭据）：连接 id + bucket/endpoint/region + 前缀任一变化 = 换了存储位置 */
function s3LocationFingerprint(s3: S3LocationConfig, prefix: string): string {
  return [s3.bucket, s3.endpoint, s3.region, prefix].join('|')
}

/** 解析协议配置引用的 S3 连接（未配置 / 非 S3 / 未找到 → 抛错） */
function resolvedS3(): { location: StorageLocation; s3: S3LocationConfig } {
  const c = getProtocolConfig()
  if (!c.locationId) throw new Error('多端同步未配置存储连接')
  const location = getStorageLocation(c.locationId)
  if (!location) throw new Error(`存储连接 ${c.locationId} 未找到`)
  if (location.kind !== 's3' || !location.s3) throw new Error('多端同步暂只支持 S3 连接')
  return { location, s3: location.s3 }
}

/** 同步前缀 = 配置前缀（归一化；capability 自持，独立于备份的 snapshots/、media/） */
function syncPrefix(prefix: string | undefined): string {
  const p = (prefix || '').replace(/^\/+/, '').replace(/\/+$/, '')
  return p === '' ? '' : `${p}/`
}

// ───────────────────── 设备身份与注册（peer 模型：无中心，注册=写共享存储）─────────────────────

let cachedDeviceId: string | null = null

/** 本端持久设备 id（data/device.id，首用生成）；客户端同理自持，互不依赖 */
export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  const path = join(dataDir, DEVICE_ID_FILE)
  if (existsSync(path)) {
    cachedDeviceId = readFileSync(path, 'utf-8').trim()
  } else {
    cachedDeviceId = crypto.randomUUID()
    writeFileSync(path, cachedDeviceId, 'utf-8')
  }
  return cachedDeviceId
}

/**
 * 更换本端设备 id（全量恢复快照后调用）：快照剥离 entity_changes，本地 seq 空间
 * 从 0 重启，而各端对旧 device_id 的高水位已越过这些小 seq——继续用旧 id 发布会被
 * 整段跳过（静默丢数据），必须以新 namespace 重新发布。
 */
function regenerateDeviceId(): void {
  cachedDeviceId = crypto.randomUUID()
  writeFileSync(join(dataDir, DEVICE_ID_FILE), cachedDeviceId, 'utf-8')
}

function getDeviceName(): string {
  const h = (process.env.HOSTNAME || hostname() || '').trim()
  return h ? `服务器 ${h}` : 'NoteFast 服务器'
}

function devicesDir(prefix: string): string {
  return `${prefix}${SYNC_S3_DIR}/devices/`
}

async function updateDeviceRegistry(store: ObjectStore, prefix: string): Promise<void> {
  const record: SyncDevice = {
    device_id: getDeviceId(),
    name: getDeviceName(),
    last_seen: new Date().toISOString(),
  }
  await store.putObject(`${devicesDir(prefix)}${record.device_id}.json`, JSON.stringify(record))
}

/** 列出共享存储中注册的设备（按最近同步倒序） */
export async function listSyncDevices(): Promise<SyncDevice[]> {
  if (!store) return []
  resolvedS3()
  const prefix = syncPrefix(getProtocolConfig().prefix)
  const keys = (await store.listObjects(devicesDir(prefix))).filter((k) => k.endsWith('.json'))
  const devices: SyncDevice[] = []
  for (const key of keys) {
    const text = await getObjectText(store, key)
    if (!text) continue
    try {
      const d = JSON.parse(text) as SyncDevice
      if (d?.device_id) devices.push(d)
    } catch { /* 损坏记录忽略 */ }
  }
  devices.sort((a, b) => (b.last_seen ?? '').localeCompare(a.last_seen ?? ''))
  return devices
}

/** 从注册表移除设备记录（展示性操作；真实拦截靠更换 S3 凭证） */
export async function removeSyncDevice(deviceId: string): Promise<boolean> {
  if (!store) return false
  resolvedS3()
  const prefix = syncPrefix(getProtocolConfig().prefix)
  await store.deleteObject(`${devicesDir(prefix)}${deviceId}.json`)
  return true
}

function rebuild(): void {
  store = null
  stopHeartbeat()
  if (!isProtocolConfigured()) {
    storeFingerprint = ''
    return
  }
  try {
    const { s3 } = resolvedS3()
    const prefix = syncPrefix(getProtocolConfig().prefix)
    store = createS3ObjectStore({
      bucket: s3.bucket,
      region: s3.region,
      endpoint: s3.endpoint,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      forcePathStyle: s3.forcePathStyle,
    })
    storeFingerprint = s3Fingerprint(s3, prefix)
    // 存储位置变化 → 旧 seq 锚点失效：重置游标，避免换位置后跳过早期变更
    const loc = s3LocationFingerprint(s3, prefix)
    if (stateLocation && stateLocation !== loc) {
      state = emptyState()
      stateLocation = loc
      saveState()
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    store = null
    storeFingerprint = ''
    return
  }
  startHeartbeat()
}

function statePath(): string {
  return join(dataDir, STATE_FILE)
}

function loadState(): SyncProtocolState {
  if (!dataDir) {
    stateLocation = ''
    return emptyState()
  }
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf-8')) as SyncProtocolState & {
      location?: string
      /** v1 存量字段（单一全局游标）：无法归因到设备，丢弃后全量重消（LWW 幂等） */
      consumedSeq?: number
    }
    stateLocation = typeof raw?.location === 'string' ? raw.location : ''
    return {
      publishedSeq: Number.isFinite(raw?.publishedSeq) ? raw.publishedSeq : 0,
      consumed: raw?.consumed && typeof raw.consumed === 'object' ? raw.consumed : {},
      sinceSnapshot: Number.isFinite(raw?.sinceSnapshot) ? raw.sinceSnapshot : 0,
      feedPruned: raw?.feedPruned === true,
    }
  } catch {
    stateLocation = ''
    return emptyState()
  }
}

function emptyState(): SyncProtocolState {
  return { publishedSeq: 0, consumed: {}, sinceSnapshot: 0, feedPruned: false }
}

function saveState(): void {
  if (!dataDir) return
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const c = getProtocolConfig()
  const loc = c.locationId ? getStorageLocation(c.locationId) : undefined
  const location = loc?.s3 ? s3LocationFingerprint(loc.s3, c.prefix ?? '') : ''
  stateLocation = location
  writeFileSync(statePath(), JSON.stringify({ ...state, location }, null, 2) + '\n', 'utf-8')
  try { chmodSync(statePath(), 0o600) } catch { /* ignore */ }
}

/** 测试钩子 */
export function _resetProtocolManagerForTests(): void {
  stopHeartbeat()
  stopDebounceTimer()
  heartbeatBusy = false
  dataDir = ''
  store = null
  running = false
  lastRunAt = null
  lastSuccessAt = null
  lastError = null
  lastRemoteDevices = null
  state = emptyState()
  stateLocation = ''
  _resetProtocolConfigForTests()
}

/** 测试钩子：注入 mock ObjectStore（覆盖 rebuild 内部创建的真实 store） */
export function _setProtocolStoreForTests(s: ObjectStore | null): void {
  store = s
}

/** 测试钩子：直接设置内存 state（模拟消费端断点续传，不触发 rebuild） */
export function _setProtocolStateForTests(s: Partial<SyncProtocolState>): void {
  state = { ...state, ...s }
}
