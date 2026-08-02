/**
 * Backup Manager：调度、互斥、状态可观察
 */

import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  emptyBackupConfig,
  type BackupConfigInput,
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
import { createBackupStore, type BackupStore } from './s3Store'
import { uploadMissingMedia, mediaPrefixFor } from './mediaBackup'
import { getMediaDir } from '../assets/store'
import { getStorageLocation } from '../storage/locations'
import { createS3ObjectStore } from '../storage/objectStore'

let dataDir = ''
let store: BackupStore | null = null
let running = false
let phase: BackupPhase = 'idle'
let lastResult: BackupRunResult | null = null
let lastRunAt: string | undefined
let lastSuccessAt: string | undefined
let lastError: string | undefined
let storeFactory: ((cfg: BackupPersistedConfig) => BackupStore | null) | null = null

export function initBackupManager(
  dir: string,
  opts?: { storeFactory?: (cfg: BackupPersistedConfig) => BackupStore | null },
): void {
  dataDir = dir
  storeFactory = opts?.storeFactory ?? null
  initBackupConfig(dir)
  rebuild()
}

export function isBackupConfigured(): boolean {
  const c = getBackupConfig()
  return Boolean(c.enabled && c.locationId && store)
}

export function backupStatus(): BackupRuntimeStatus {
  const c = getBackupConfig()
  return {
    configured: isBackupConfigured(),
    enabled: Boolean(c.enabled && c.locationId),
    running,
    phase,
    lastRunAt,
    lastSuccessAt,
    lastError,
    lastResult,
    locationId: c.locationId,
    retentionDays: c.retentionDays,
  }
}

export async function applyBackupManagerConfig(incoming: BackupConfigInput): Promise<BackupRuntimeStatus> {
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

export function getBackupStore(): BackupStore | null {
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
    // 复用 store 的底层对象存储（同一凭据/连接）
    let mediaUploaded: { uploaded: number; skipped: number } | undefined
    if (c.locationId && store) {
      const mediaDir = getMediaDir()
      if (mediaDir) {
        try {
          const media = await uploadMissingMedia(store.objectStore, mediaPrefixFor(c.prefix), mediaDir)
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
  }
}

function rebuild(): void {
  store = null
  const c = getBackupConfig()
  if (!c.enabled || !c.locationId) {
    return
  }
  const loc = getStorageLocation(c.locationId)
  if (!loc) {
    lastError = `存储连接 ${c.locationId} 未找到`
    return
  }
  if (loc.kind !== 's3' || !loc.s3) {
    lastError = '备份暂只支持 S3 连接'
    return
  }
  if (!loc.s3.accessKeyId || !loc.s3.secretAccessKey || !loc.s3.bucket || !loc.s3.region) {
    lastError = 'S3 连接不完整'
    return
  }
  try {
    const s3 = loc.s3
    const objectStore = createS3ObjectStore({
      bucket: s3.bucket,
      region: s3.region,
      endpoint: s3.endpoint,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      forcePathStyle: s3.forcePathStyle,
    })
    store = storeFactory ? storeFactory(c) : createBackupStore(s3, c.prefix, objectStore)
    console.log(`💾 Backup: ${loc.name} s3://${s3.bucket}/${c.prefix || ''}`)
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    console.error('💾 Backup 初始化失败:', lastError)
    return
  }
}

export function stopBackupManager(): void {
  // 备份仅支持手动，无定时器；保留此钩子以便进程退出时统一收尾
}

export function _resetBackupManagerForTests(): void {
  dataDir = ''
  store = null
  running = false
  phase = 'idle'
  lastResult = null
  lastRunAt = undefined
  lastSuccessAt = undefined
  lastError = undefined
  storeFactory = null
  _resetBackupConfigForTests()
}

export { getBackupConfig, getBackupPublicConfig, emptyBackupConfig }
