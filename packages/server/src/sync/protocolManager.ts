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
  consumeChanges,
  readManifest,
  updateManifest,
} from './protocol'

const STATE_FILE = 'sync-state.json'

export interface SyncProtocolState {
  /** 上次已发布到 S3 的 seq（不含；下一轮从此导出） */
  publishedSeq: number
  /** 已消费的远端 seq（不含；下一轮从此拉取） */
  consumedSeq: number
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
let client: S3Client | null = null
let running = false
let lastRunAt: string | null = null
let lastSuccessAt: string | null = null
let lastError: string | null = null
let state: SyncProtocolState = { publishedSeq: 0, consumedSeq: 0 }

/** 启动期初始化（dataDir + 复用 backup S3 配置） */
export function initProtocolManager(dir: string): void {
  dataDir = dir
  initBackupConfig(dir)
  state = loadState()
  rebuild()
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
  }
}

/**
 * 执行一轮同步：发布本地增量 → 消费远端增量 → 持久化 state。
 * 双向都对账到当前锚点。幂等；失败抛错（调用方记录/上报）。
 */
export async function syncNow(): Promise<{ published: number; applied: number; state: SyncProtocolState }> {
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

    // 1) 发布本地增量（本端 → S3）
    const newPublished = await publishChanges(db, { bucket: cfg.bucket, prefix }, client, state.publishedSeq)
    // 2) 读远端 manifest，决定消费到哪
    const manifest = await readManifest(client, { bucket: cfg.bucket, prefix })
    const upTo = manifest?.last_seq ?? newPublished
    // 3) 消费远端增量（S3 → 本端；LWW 裁决，自己刚发布的内容会被跳过）
    const consumed = await consumeChanges(db, client, { bucket: cfg.bucket, prefix }, state.consumedSeq, upTo)
    // 4) 更新 manifest（本端也参与发布后，last_seq 前进到最新）
    const anchor = newPublished > upTo ? newPublished : upTo
    await updateManifest(client, { bucket: cfg.bucket, prefix }, anchor, manifest?.snapshot_seq ?? 0)

    const published = newPublished - state.publishedSeq
    state = { publishedSeq: newPublished, consumedSeq: consumed.nextSeq }
    saveState()
    lastSuccessAt = lastRunAt
    lastError = null
    return { published, applied: consumed.applied, state }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    running = false
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
  if (!isProtocolConfigured()) return
  try {
    const store = createS3Store(s3Cfg())
    client = store.mediaClient ?? null
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    client = null
  }
}

// ───────────────────── state 持久化 ─────────────────────

function statePath(): string {
  return join(dataDir, STATE_FILE)
}

function loadState(): SyncProtocolState {
  if (!dataDir) return { publishedSeq: 0, consumedSeq: 0 }
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf-8')) as SyncProtocolState
    return {
      publishedSeq: Number.isFinite(raw?.publishedSeq) ? raw.publishedSeq : 0,
      consumedSeq: Number.isFinite(raw?.consumedSeq) ? raw.consumedSeq : 0,
    }
  } catch {
    return { publishedSeq: 0, consumedSeq: 0 }
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
  dataDir = ''
  client = null
  running = false
  lastRunAt = null
  lastSuccessAt = null
  lastError = null
  state = { publishedSeq: 0, consumedSeq: 0 }
}

/** 测试钩子：注入 mock S3Client（覆盖 rebuild 内部创建的真实 client） */
export function _setProtocolClientForTests(c: S3Client | null): void {
  client = c
}
