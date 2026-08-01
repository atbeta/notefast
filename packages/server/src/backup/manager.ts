/**
 * Backup Manager：调度、互斥、状态可观察
 */

import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  emptyBackupConfig,
  type BackupPersistedConfig,
  type BackupPhase,
  type BackupRestorePoint,
  type BackupRunResult,
  type BackupRuntimeStatus,
} from '@notefast/core'
import {
  applyBackupConfig,
  disableBackupConfig,
  getBackupConfig,
  getBackupPublicConfig,
  initBackupConfig,
  _resetBackupConfigForTests,
} from './config'
import { cleanupSnapshot, createLocalSnapshot } from './snapshot'
import { createS3Store, type S3StoreLike } from './s3Store'
import { uploadMissingMedia } from './mediaBackup'
import { getMediaDir } from '../assets/store'

let dataDir = ''
let store: S3StoreLike | null = null
let running = false
let phase: BackupPhase = 'idle'
let lastResult: BackupRunResult | null = null
let lastRunAt: string | undefined
let lastSuccessAt: string | undefined
let lastError: string | undefined
let timer: ReturnType<typeof setInterval> | null = null
let nextRunAt: string | undefined
let storeFactory: ((cfg: BackupPersistedConfig) => S3StoreLike | null) | null = null

export function initBackupManager(
  dir: string,
  opts?: { storeFactory?: (cfg: BackupPersistedConfig) => S3StoreLike | null },
): void {
  dataDir = dir
  storeFactory = opts?.storeFactory ?? null
  initBackupConfig(dir)
  rebuild()
}

export function isBackupConfigured(): boolean {
  const c = getBackupConfig()
  return Boolean(c.enabled && c.s3 && store)
}

export function backupStatus(): BackupRuntimeStatus {
  const c = getBackupConfig()
  return {
    configured: isBackupConfigured(),
    enabled: Boolean(c.enabled && c.s3),
    running,
    phase,
    lastRunAt,
    lastSuccessAt,
    lastError,
    lastResult,
    intervalMs: c.intervalMs,
    retentionDays: c.retentionDays,
    nextRunAt,
  }
}

export async function applyBackupManagerConfig(incoming: BackupPersistedConfig): Promise<BackupRuntimeStatus> {
  applyBackupConfig(incoming)
  rebuild()
  return backupStatus()
}

export async function disableBackupManager(): Promise<BackupRuntimeStatus> {
  disableBackupConfig()
  rebuild()
  return backupStatus()
}

export async function testBackupConnection(): Promise<{ ok: boolean; error?: string }> {
  if (!store) return { ok: false, error: '备份未配置' }
  return store.testConnection()
}

export async function listBackupRestorePoints(limit = 50): Promise<BackupRestorePoint[]> {
  if (!store) throw new Error('备份未配置')
  return store.listRestorePoints({ limit })
}

export function getBackupStore(): S3StoreLike | null {
  return store
}

export async function runBackupNow(): Promise<BackupRunResult> {
  if (!store) {
    const err = '备份未配置或未启用'
    throw Object.assign(new Error(err), { code: 'not_configured' })
  }
  if (running) {
    throw Object.assign(new Error('备份任务正在进行中'), { code: 'backup_in_progress' })
  }

  const c = getBackupConfig()
  running = true
  phase = 'snapshot'
  const startedAt = new Date().toISOString()
  lastRunAt = startedAt
  lastError = undefined

  const workRoot = join(dataDir, '.backup-tmp')
  if (!existsSync(workRoot)) mkdirSync(workRoot, { recursive: true })

  let tempDir: string | undefined
  try {
    const snap = await createLocalSnapshot(workRoot)
    tempDir = snap.tempDir
    phase = 'verify'

    phase = 'upload'
    const appVersion = (process.env.APP_VERSION || '').trim().replace(/^v/, '') || undefined
    const uploaded = await store.uploadSnapshot({
      localPath: snap.path,
      sha256: snap.sha256,
      sizeBytes: snap.sizeBytes,
      schemaVersion: snap.schemaVersion,
      appVersion,
    })

    // media 上送：内容寻址增量（幂等）。失败不阻断快照本身（库仍完整），单独记录。
    // 复用 store 的底层 S3Client（同一凭据/连接）；mock store 无 mediaClient 时跳过
    let mediaUploaded: { uploaded: number; skipped: number } | undefined
    if (c.s3 && store.mediaClient) {
      const mediaDir = getMediaDir()
      if (mediaDir) {
        try {
          const media = await uploadMissingMedia(c.s3, mediaDir, { client: store.mediaClient })
          mediaUploaded = { uploaded: media.uploaded, skipped: media.skipped }
          if (media.errors.length > 0) {
            console.warn(`[backup] media 上送 ${media.errors.length} 个失败，快照仍成功`)
          }
        } catch (e) {
          console.warn('[backup] media 上送失败（快照仍成功）:', e instanceof Error ? e.message : e)
        }
      }
    }

    phase = 'prune'
    if (c.retentionDays > 0) {
      await store.pruneOlderThan(c.retentionDays)
    }

    phase = 'done'
    const finishedAt = new Date().toISOString()
    const result: BackupRunResult = {
      ok: true,
      startedAt,
      finishedAt,
      objectKey: uploaded.objectKey,
      manifestKey: uploaded.manifestKey,
      sizeBytes: snap.sizeBytes,
      sha256: snap.sha256,
      schemaVersion: snap.schemaVersion,
      mediaUploaded,
    }
    lastResult = result
    lastSuccessAt = finishedAt
    lastError = undefined
    return result
  } catch (e) {
    phase = 'error'
    const finishedAt = new Date().toISOString()
    const message = e instanceof Error ? e.message : String(e)
    const result: BackupRunResult = {
      ok: false,
      startedAt,
      finishedAt,
      error: message,
    }
    lastResult = result
    lastError = message
    throw e
  } finally {
    if (tempDir) cleanupSnapshot(tempDir)
    running = false
    if (phase !== 'error') phase = 'idle'
    scheduleNext()
  }
}

function rebuild(): void {
  stopTimer()
  store = null
  const c = getBackupConfig()
  if (!c.enabled || !c.s3) {
    nextRunAt = undefined
    return
  }
  if (!c.s3.accessKeyId || !c.s3.secretAccessKey || !c.s3.bucket || !c.s3.region) {
    lastError = 'S3 配置不完整'
    return
  }
  try {
    store = storeFactory ? storeFactory(c) : createS3Store(c.s3)
    console.log(`💾 Backup: S3 s3://${c.s3.bucket}/${c.s3.prefix || ''}`)
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    console.error('💾 Backup 初始化失败:', lastError)
    return
  }
  if (c.intervalMs > 0) {
    timer = setInterval(() => {
      runBackupNow().catch((err) => {
        const code = (err as { code?: string } | null)?.code
        if (code === 'backup_in_progress') {
          // 重叠跳过：不记 lastError，只重排下次槽位，避免长事务期间连续丢 tick
          scheduleNext()
          return
        }
        console.warn('[backup] auto run failed:', err instanceof Error ? err.message : err)
        // 未进入 run 主体的失败（如 not_configured）也没有 finally 重排
        scheduleNext()
      })
    }, c.intervalMs)
    scheduleNext()
    if (!process.env.BACKUP_QUIET) {
      console.log(`💾 Backup auto interval: ${c.intervalMs}ms`)
    }
  } else {
    nextRunAt = undefined
  }
}

/** 测试钩子：模拟自动 tick 的错误处理（重叠跳过 vs 真实错误） */
export function _handleAutoBackupTickErrorForTests(err: unknown): void {
  const code = (err as { code?: string } | null)?.code
  if (code === 'backup_in_progress') {
    scheduleNext()
    return
  }
  scheduleNext()
}

function scheduleNext(): void {
  const c = getBackupConfig()
  if (c.intervalMs > 0 && store) {
    nextRunAt = new Date(Date.now() + c.intervalMs).toISOString()
  } else {
    nextRunAt = undefined
  }
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function stopBackupManager(): void {
  stopTimer()
}

export function _resetBackupManagerForTests(): void {
  stopTimer()
  dataDir = ''
  store = null
  running = false
  phase = 'idle'
  lastResult = null
  lastRunAt = undefined
  lastSuccessAt = undefined
  lastError = undefined
  nextRunAt = undefined
  storeFactory = null
  _resetBackupConfigForTests()
}

export { getBackupConfig, getBackupPublicConfig, emptyBackupConfig }
