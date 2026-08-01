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
import type { S3Client } from '@aws-sdk/client-s3'
import { getBackupConfig, initBackupConfig } from '../backup/config'
import { createS3Store } from '../backup/s3Store'
import { initDb, closeDb, getDb, getDbPath } from '../db'
import { collectReferencedAssetIds, getMediaDir } from '../assets/store'
import { restoreReferencedMedia } from '../backup/mediaBackup'
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
  /** 自动同步间隔（ms）；0 = 不自动 */
  autoSyncIntervalMs: number
}

let dataDir = ''
let client: S3Client | null = null
/** 当前 client 对应的备份 S3 配置指纹（懒重建判断用） */
let clientFingerprint = ''
let running = false
let lastRunAt: string | null = null
let lastSuccessAt: string | null = null
let lastError: string | null = null
let autoTimer: ReturnType<typeof setInterval> | null = null
let autoIntervalMs = 0
let state: SyncProtocolState = { publishedSeq: 0, consumedSeq: 0, sinceSnapshot: 0 }
/** 编辑后去抖同步定时器（合并多次写入为一次同步） */
let debounceTimer: ReturnType<typeof setTimeout> | null = null
/** 去抖窗口：写入后延迟触发，期间多次写入合并为一次 */
const SYNC_DEBOUNCE_MS = 5_000

/** 启动期初始化（dataDir + 复用 backup S3 配置） */
export function initProtocolManager(dir: string, opts?: { autoSyncIntervalMs?: number }): void {
  dataDir = dir
  autoIntervalMs = Math.max(0, opts?.autoSyncIntervalMs ?? 0)
  initBackupConfig(dir)
  state = loadState()
  rebuild()
  if (autoIntervalMs > 0) startAutoTimer()
}

/** 是否已配置（backup S3 可用） */
export function isProtocolConfigured(): boolean {
  const c = getBackupConfig()
  return Boolean(c.s3?.bucket && c.s3?.accessKeyId && c.s3?.secretAccessKey && c.s3?.region)
}

export function protocolStatus(): SyncProtocolStatus {
  const c = getBackupConfig()
  // 懒重建：备份 S3 配置可在运行期（备份面板）更新，而 client 只在 init 时创建。
  // 配置已就绪但 client 未建、或配置指纹变化（bucket/key/endpoint 等改动）时自动重建，
  // 否则同步永远「未配置」或用着旧凭据。
  const fingerprint = c.s3 ? backupFingerprint(c.s3) : ''
  if (isProtocolConfigured() && (!client || clientFingerprint !== fingerprint)) {
    rebuild()
    clientFingerprint = client ? fingerprint : ''
  }
  return {
    configured: isProtocolConfigured(),
    enabled: Boolean(client),
    s3Bucket: c.s3?.bucket,
    s3Prefix: c.s3?.prefix,
    lastRunAt: lastRunAt ?? undefined,
    lastSuccessAt: lastSuccessAt ?? undefined,
    lastError: lastError ?? undefined,
    state,
    running,
    autoSyncIntervalMs: autoIntervalMs,
  }
}

/**
 * 执行一轮同步（发布端语义）：发布本地增量 → 定期生成快照（compaction）→ 更新 manifest。
 * 消费端合并由客户端复用 consumeChanges/consumeSnapshot（服务端是权威之一，不被快照覆盖）。
 */
export async function syncNow(): Promise<{ published: number; snapshotCreated: boolean; state: SyncProtocolState }> {
  if (!client) {
    throw Object.assign(new Error('同步协议未配置（backup S3 未配置）'), { code: 'not_configured' })
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

    // 1) 发布本地增量（本端 → S3）
    const newPublished = await publishChanges(db, { bucket: cfg.bucket, prefix }, client, state.publishedSeq)

    // 2) compaction 触发：累计轮数达阈值 → 新快照 + 清理旧增量
    let snapshotCreated = false
    let snapAnchor = 0
    state.sinceSnapshot += 1
    if (state.sinceSnapshot >= SNAPSHOT_EVERY_N) {
      snapAnchor = await compactChanges(db, client, { bucket: cfg.bucket, prefix }, workRoot)
      // compact 后旧增量已删，publishedSeq 应重置为快照锚点（快照已涵盖，无需再导出）
      state.publishedSeq = snapAnchor
      state.sinceSnapshot = 0
      snapshotCreated = true
    }

    // 3) 更新 manifest（compaction 后 snapshot_seq = 新快照锚点）
    const manifest = await readManifest(client, { bucket: cfg.bucket, prefix })
    await updateManifest(
      client,
      { bucket: cfg.bucket, prefix },
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
  if (!client) {
    throw Object.assign(new Error('同步协议未配置（backup S3 未配置）'), { code: 'not_configured' })
  }
  if (running) {
    throw Object.assign(new Error('同步进行中'), { code: 'sync_in_progress' })
  }
  running = true
  lastRunAt = new Date().toISOString()
  try {
    const cfg = s3Cfg()
    const prefix = syncPrefix(cfg.prefix)
    const manifest = await readManifest(client, { bucket: cfg.bucket, prefix })
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
      const snapSeq = await consumeSnapshot(client, { bucket: cfg.bucket, prefix }, target)
      // 重新打开库（读引用集合 / 后续使用）
      initDb(dataDir)
      state.consumedSeq = snapSeq
      applied = snapSeq
    } else {
      // 增量：合并 snapshot_seq 之后到 last_seq 的变更
      const consumed = await consumeChanges(getDb(), client, { bucket: cfg.bucket, prefix }, state.consumedSeq, manifest.last_seq)
      applied = consumed.applied
      state.consumedSeq = consumed.nextSeq
    }

    // media 拉回（引用集合；内容寻址跳过已有，成本低）
    let mediaRestored = 0
    const mediaDir = getMediaDir()
    if (mediaDir) {
      const refs = collectReferencedAssetIds()
      if (refs.size > 0) {
        const mediaRes = await restoreReferencedMedia(cfg, mediaDir, refs, { client })
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

function startAutoTimer(): void {
  stopAutoTimer()
  if (!client || autoIntervalMs <= 0) return
  autoTimer = setInterval(() => {
    syncNow().catch((err) => {
      const code = (err as { code?: string }).code
      if (code !== 'sync_in_progress') {
        console.warn('[sync-protocol] auto run failed:', err instanceof Error ? err.message : err)
      }
    })
  }, autoIntervalMs)
}

function stopAutoTimer(): void {
  if (autoTimer) {
    clearInterval(autoTimer)
    autoTimer = null
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
    if (!client) return // 未配置同步：静默跳过
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
function backupFingerprint(s3: NonNullable<ReturnType<typeof getBackupConfig>['s3']>): string {
  return [s3.bucket, s3.endpoint, s3.region, s3.prefix, s3.accessKeyId, s3.secretAccessKey, s3.forcePathStyle].join('|')
}

function s3Cfg(): NonNullable<ReturnType<typeof getBackupConfig>['s3']> {
  const s3 = getBackupConfig().s3
  if (!s3) throw new Error('backup S3 未配置')
  return s3
}

/** 同步前缀 = backup prefix + 'sync/'（与 snapshots/、media/ 并列） */
function syncPrefix(backupPrefix: string | undefined): string {
  const p = (backupPrefix || '').replace(/^\/+/, '').replace(/\/+$/, '')
  return p === '' ? '' : `${p}/`
}

function rebuild(): void {
  client = null
  stopAutoTimer()
  if (!isProtocolConfigured()) {
    clientFingerprint = ''
    return
  }
  try {
    const cfg = s3Cfg()
    const store = createS3Store(cfg)
    client = store.mediaClient ?? null
    clientFingerprint = backupFingerprint(cfg)
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    client = null
    clientFingerprint = ''
    return
  }
  if (autoIntervalMs > 0) startAutoTimer()
}

// ───────────────────── state 持久化 ─────────────────────

function statePath(): string {
  return join(dataDir, STATE_FILE)
}

function loadState(): SyncProtocolState {
  if (!dataDir) return { publishedSeq: 0, consumedSeq: 0, sinceSnapshot: 0 }
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf-8')) as SyncProtocolState
    return {
      publishedSeq: Number.isFinite(raw?.publishedSeq) ? raw.publishedSeq : 0,
      consumedSeq: Number.isFinite(raw?.consumedSeq) ? raw.consumedSeq : 0,
      sinceSnapshot: Number.isFinite(raw?.sinceSnapshot) ? raw.sinceSnapshot : 0,
    }
  } catch {
    return { publishedSeq: 0, consumedSeq: 0, sinceSnapshot: 0 }
  }
}

function saveState(): void {
  if (!dataDir) return
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n', 'utf-8')
  try { chmodSync(statePath(), 0o600) } catch { /* ignore */ }
}

/** 测试钩子 */
export function _resetProtocolManagerForTests(): void {
  stopAutoTimer()
  stopDebounceTimer()
  dataDir = ''
  client = null
  running = false
  lastRunAt = null
  lastSuccessAt = null
  lastError = null
  autoIntervalMs = 0
  state = { publishedSeq: 0, consumedSeq: 0, sinceSnapshot: 0 }
}

/** 测试钩子：注入 mock S3Client（覆盖 rebuild 内部创建的真实 client） */
export function _setProtocolClientForTests(c: S3Client | null): void {
  client = c
}

/** 测试钩子：直接设置内存 state（模拟消费端断点续传，不触发 rebuild） */
export function _setProtocolStateForTests(s: Partial<SyncProtocolState>): void {
  state = { ...state, ...s }
}
