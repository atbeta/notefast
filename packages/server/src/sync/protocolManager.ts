/**
 * 同步协议 Manager（方案 A：客户端与 Web 共享同一份 S3）
 *
 * 与 sync/manager.ts（单向 Markdown 归档）独立：这里是双向增量同步。
 * - 配置复用 backup 的 S3 凭据（同一份库的身份 = 存储位置 + 凭据），
 *   同步用独立前缀 {prefix}sync/，不新增配置维度
 * - state 持久化到 data/sync-state.json（publishedSeq / consumedSeq）
 * - syncNow() = publish → consume → 持久化 state
 *
 * 编排注意：publish 和 consume 在同一前缀，consume 会拉回自己刚发布的内容，
 * 但 LWW 裁决（updated_at 相等）会跳过，无副作用。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createS3ObjectStore, type ObjectStore } from '../storage/objectStore'
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
import type { SyncProtocolConfigInput } from '@notefast/core'
import {
  publishChanges,
  consumeChanges,
  consumeSnapshot,
  compactChanges,
  readManifest,
  updateManifest,
} from './protocol'

const STATE_FILE = 'sync-state.json'
/** 每 N 次同步生成一次快照（compaction 兜底阈值） */
const SNAPSHOT_EVERY_N = 10

export interface SyncProtocolState {
  /** 上次已发布到 S3 的 seq（不含；下一轮从此导出） */
  publishedSeq: number
  /** 已消费的远端 seq（不含；下一轮从此拉取） */
  consumedSeq: number
  /** 自上次快照以来累计的同步轮数（触发 compaction） */
  sinceSnapshot: number
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
  running: boolean
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
let state: SyncProtocolState = { publishedSeq: 0, consumedSeq: 0, sinceSnapshot: 0 }
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

/** 是否已配置（独立 S3 可用且已启用） */
export function isProtocolConfigured(): boolean {
  const c = getProtocolConfig()
  return Boolean(c.enabled && c.s3?.bucket && c.s3?.accessKeyId && c.s3?.secretAccessKey && c.s3?.region)
}

export function protocolStatus(): SyncProtocolStatus {
  const c = getProtocolConfig()
  // 懒重建：配置可在运行期（多端同步面板）更新，而 store 只在 init 时创建。
  // 配置已就绪但 store 未建、或配置指纹变化（bucket/key/endpoint 等改动）时自动重建，
  // 否则同步永远「未配置」或用着旧凭据。
  const fingerprint = c.s3 ? s3Fingerprint(c.s3) : ''
  if (isProtocolConfigured() && (!store || storeFingerprint !== fingerprint)) {
    rebuild()
    storeFingerprint = store ? fingerprint : ''
  }
  return {
    configured: isProtocolConfigured(),
    enabled: Boolean(store),
    s3Bucket: c.s3?.bucket,
    s3Prefix: c.s3?.prefix,
    lastRunAt: lastRunAt ?? undefined,
    lastSuccessAt: lastSuccessAt ?? undefined,
    lastError: lastError ?? undefined,
    state,
    running,
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

/**
 * 执行一轮同步（发布端语义）：发布本地增量 → 定期生成快照（compaction）→ 更新 manifest。
 * 消费端合并由客户端复用 consumeChanges/consumeSnapshot（服务端是权威之一，不被快照覆盖）。
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
    const cfg = s3Cfg()
    const prefix = syncPrefix(cfg.prefix)
    const workRoot = join(dataDir, '.sync-tmp')
    if (!existsSync(workRoot)) mkdirSync(workRoot, { recursive: true })

    // 1) 发布本地增量（本端 → 存储）
    const newPublished = await publishChanges(db, store, prefix, state.publishedSeq)

    // 2) media 上送：让同步位置自包含（内容寻址增量幂等；失败不阻断变更发布）
    const mediaDir = getMediaDir()
    if (mediaDir) {
      try {
        await uploadMissingMedia(store, mediaPrefixFor(cfg.prefix), mediaDir)
      } catch (e) {
        console.warn('[sync] media 上送失败（变更仍发布）:', e instanceof Error ? e.message : e)
      }
    }

    // 3) compaction 触发：累计轮数达阈值 → 新快照 + 清理旧增量
    let snapshotCreated = false
    let snapAnchor = 0
    state.sinceSnapshot += 1
    if (state.sinceSnapshot >= SNAPSHOT_EVERY_N) {
      snapAnchor = await compactChanges(db, store, prefix, workRoot)
      // compact 后旧增量已删，publishedSeq 应重置为快照锚点（快照已涵盖，无需再导出）
      state.publishedSeq = snapAnchor
      state.sinceSnapshot = 0
      snapshotCreated = true
    }

    // 4) 更新 manifest（compaction 后 snapshot_seq = 新快照锚点）
    const manifest = await readManifest(store, prefix)
    await updateManifest(
      store,
      prefix,
      newPublished,
      snapshotCreated ? snapAnchor : (manifest?.snapshot_seq ?? 0),
    )

    const published = newPublished - (snapshotCreated ? snapAnchor : state.publishedSeq)
    state.publishedSeq = newPublished
    saveState()
    lastSuccessAt = lastRunAt
    lastError = null
    return { published: Math.max(0, published), snapshotCreated, state }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    running = false
  }
}

/**
 * 消费端拉取（客户端「从 S3 恢复到本地」的入口）：
 * 1. 读 manifest，判断全量 or 增量
 * 2. 全量：本地落后于最近快照（consumedSeq < snapshot_seq）或本地无库 → closeDb + consumeSnapshot
 *    重建库文件 → 重新 initDb → media 拉回 → consumedSeq = snapshot_seq
 * 3. 增量：consumeChanges 合并到 snapshot_seq 之后的变更 → media 拉回
 * 4. 持久化 state
 *
 * 语义：消费端在**独立进程/客户端**跑；server 内调用时，全量路径会 closeDb（库文件被替换），
 * 调用方需理解这是「恢复到本地」而非「服务端自合并」。
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
    const cfg = s3Cfg()
    const prefix = syncPrefix(cfg.prefix)
    const manifest = await readManifest(store, prefix)
    if (!manifest) {
      throw Object.assign(new Error('远端无同步数据（manifest 不存在）'), { code: 'no_remote' })
    }
    const snapshotSeq = manifest.snapshot_seq ?? 0
    const needFull = state.consumedSeq < snapshotSeq

    let mode: 'full' | 'incremental' = 'incremental'
    let applied = 0
    if (needFull) {
      // 全量：重建本地库文件
      mode = 'full'
      const target = getDbPath()
      try { closeDb() } catch { /* 未打开也 OK */ }
      const snapSeq = await consumeSnapshot(store, prefix, target)
      // 重新打开库（读引用集合 / 后续使用）
      initDb(dataDir)
      state.consumedSeq = snapSeq
      applied = snapSeq
    } else {
      // 增量：合并 snapshot_seq 之后到 last_seq 的变更
      const consumed = await consumeChanges(getDb(), store, prefix, state.consumedSeq, manifest.last_seq)
      applied = consumed.applied
      state.consumedSeq = consumed.nextSeq
    }

    // media 拉回（引用集合；内容寻址跳过已有，成本低）
    let mediaRestored = 0
    const mediaDir = getMediaDir()
    if (mediaDir) {
      const refs = collectReferencedAssetIds()
      if (refs.size > 0) {
        const mediaRes = await restoreReferencedMedia(store, mediaPrefixFor(cfg.prefix), mediaDir, refs)
        mediaRestored = mediaRes.restored
      }
    }

    saveState()
    lastSuccessAt = lastRunAt
    lastError = null
    return { mode, applied, mediaRestored, state }
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
 * 多端收敛与兜底推送；无变更时 publish 早退、consume 按序跳过，成本可忽略。
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

/** 服务端安全合并远端变更：落后于快照时不恢复自身（保持权威，交给客户端全量拉取） */
async function safeMergeRemote(): Promise<void> {
  if (!store) return
  const cfg = s3Cfg()
  const prefix = syncPrefix(cfg.prefix)
  const manifest = await readManifest(store, prefix)
  if (!manifest) return
  const snapshotSeq = manifest.snapshot_seq ?? 0
  if (state.consumedSeq < snapshotSeq) return
  const consumed = await consumeChanges(getDb(), store, prefix, state.consumedSeq, manifest.last_seq)
  if (consumed.nextSeq > state.consumedSeq) {
    state.consumedSeq = consumed.nextSeq
    saveState()
  }
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

// ───────────────────── 内部 ─────────────────────

/** S3 配置指纹：bucket/endpoint/region/prefix/凭据任一变化 → 指纹变 → 重建 client */
function s3Fingerprint(s3: NonNullable<ReturnType<typeof getProtocolConfig>['s3']>): string {
  return [s3.bucket, s3.endpoint, s3.region, s3.prefix, s3.accessKeyId, s3.secretAccessKey, s3.forcePathStyle].join('|')
}

/** S3 位置指纹（不含凭据）：bucket/endpoint/region/prefix 任一变化 = 换了存储位置 */
function s3LocationFingerprint(s3: NonNullable<ReturnType<typeof getProtocolConfig>['s3']>): string {
  return [s3.bucket, s3.endpoint, s3.region, s3.prefix].join('|')
}

function s3Cfg(): NonNullable<ReturnType<typeof getProtocolConfig>['s3']> {
  const s3 = getProtocolConfig().s3
  if (!s3) throw new Error('多端同步 S3 未配置')
  return s3
}

/** 同步前缀 = 配置前缀 + 'sync/'（多端同步独立于备份的 snapshots/、media/） */
function syncPrefix(prefix: string | undefined): string {
  const p = (prefix || '').replace(/^\/+/, '').replace(/\/+$/, '')
  return p === '' ? '' : `${p}/`
}

function rebuild(): void {
  store = null
  stopHeartbeat()
  if (!isProtocolConfigured()) {
    storeFingerprint = ''
    return
  }
  try {
    const cfg = s3Cfg()
    store = createS3ObjectStore({
      bucket: cfg.bucket,
      region: cfg.region,
      endpoint: cfg.endpoint,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      forcePathStyle: cfg.forcePathStyle,
    })
    storeFingerprint = s3Fingerprint(cfg)
    // 存储位置变化 → 旧 seq 锚点失效：重置游标，避免换位置后跳过早期变更
    const loc = s3LocationFingerprint(cfg)
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
    }
    stateLocation = typeof raw?.location === 'string' ? raw.location : ''
    return {
      publishedSeq: Number.isFinite(raw?.publishedSeq) ? raw.publishedSeq : 0,
      consumedSeq: Number.isFinite(raw?.consumedSeq) ? raw.consumedSeq : 0,
      sinceSnapshot: Number.isFinite(raw?.sinceSnapshot) ? raw.sinceSnapshot : 0,
    }
  } catch {
    stateLocation = ''
    return emptyState()
  }
}

function emptyState(): SyncProtocolState {
  return { publishedSeq: 0, consumedSeq: 0, sinceSnapshot: 0 }
}

function saveState(): void {
  if (!dataDir) return
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const cfg = getProtocolConfig()
  const location = cfg.s3 ? s3LocationFingerprint(cfg.s3) : ''
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
