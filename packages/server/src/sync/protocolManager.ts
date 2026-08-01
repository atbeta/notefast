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
import { getDb } from '../db'
import {
  publishChanges,
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
let running = false
let lastRunAt: string | null = null
let lastSuccessAt: string | null = null
let lastError: string | null = null
let autoTimer: ReturnType<typeof setInterval> | null = null
let autoIntervalMs = 0
let state: SyncProtocolState = { publishedSeq: 0, consumedSeq: 0, sinceSnapshot: 0 }

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

// ───────────────────── 内部 ─────────────────────

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
  if (!isProtocolConfigured()) return
  try {
    const store = createS3Store(s3Cfg())
    client = store.mediaClient ?? null
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    client = null
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
