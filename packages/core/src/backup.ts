/**
 * 数据库备份领域模型
 *
 * 与 Markdown 归档（sync）、多端同步完全独立的能力，但**共享存储连接库**：
 * 连接（bucket/凭据）存 data/storage-locations.json，这里只引用 locationId + 前缀。
 */

import { z } from 'zod'

/** 当前程序支持的最高 schema 版本；恢复时备份版本不得高于此值 */
export const CURRENT_SCHEMA_VERSION = 10

/** 默认保留天数 */
export const DEFAULT_BACKUP_RETENTION_DAYS = 30

/** 持久化到 data/backup.config.json */
export interface BackupPersistedConfig {
  version: 1
  enabled: boolean
  /** 引用的存储连接 id（storage-locations.json）；null = 未配置 */
  locationId: string | null
  /**
   * 本地备份目录（LocalFS，客户端/单机场景）；非空时优先于 locationId。
   * 与 Markdown 归档的 localfs 适配器同语义：快照写入 <dir>/<prefix>snapshots/。
   */
  localDir: string | null
  /** 备份对象前缀（snapshots/、media/ 之下的命名空间）；归一化带尾斜杠 */
  prefix: string
  /** 保留天数；超过后删除 NoteFast 管理的恢复点 */
  retentionDays: number
}

/** applyBackupConfig 入参形态（version 由服务端补全；localDir 缺省 = 保留现有值） */
export type BackupConfigInput = Omit<BackupPersistedConfig, 'version' | 'localDir'> & {
  localDir?: string | null
}

export type BackupPhase =
  | 'idle'
  | 'snapshot'
  | 'verify'
  | 'upload'
  | 'prune'
  | 'done'
  | 'error'

export interface BackupRuntimeStatus {
  configured: boolean
  enabled: boolean
  running: boolean
  phase: BackupPhase
  lastRunAt?: string
  lastSuccessAt?: string
  lastError?: string
  lastResult?: BackupRunResult | null
  locationId?: string | null
  retentionDays: number
}

export interface BackupRunResult {
  ok: boolean
  startedAt: string
  finishedAt: string
  objectKey?: string
  manifestKey?: string
  sizeBytes?: number
  sha256?: string
  schemaVersion?: number
  /** media 内容寻址上送统计（有 media 且上送尝试过时存在） */
  mediaUploaded?: { uploaded: number; skipped: number }
  error?: string
}

/** 上传到 S3 的恢复点元数据（与 .db 对象并列的 .manifest.json） */
export interface BackupManifest {
  app: 'notefast'
  kind: 'sqlite-snapshot'
  version: 1
  createdAt: string
  objectKey: string
  sizeBytes: number
  sha256: string
  schemaVersion: number
  /** 可选：创建该恢复点时的应用版本 */
  appVersion?: string
}

export interface BackupRestorePoint {
  objectKey: string
  manifestKey: string
  createdAt: string
  sizeBytes: number
  sha256: string
  schemaVersion: number
  appVersion?: string
}

export function emptyBackupConfig(): BackupPersistedConfig {
  return {
    version: 1,
    enabled: false,
    locationId: null,
    localDir: null,
    prefix: '',
    retentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
  }
}

export function publicBackupView(cfg: BackupPersistedConfig): BackupPersistedConfig {
  // 无内嵌密钥（连接信息在 storage-locations.json），原样返回
  return cfg
}

/** 合并 PUT 请求与磁盘配置（归一化前缀；密钥随连接库；localDir 三态见下） */
export function mergeBackupConfig(
  incoming: BackupConfigInput,
  existing: BackupPersistedConfig,
): BackupPersistedConfig {
  return {
    version: 1,
    enabled: incoming.enabled,
    locationId: incoming.locationId ?? null,
    // localDir 三态：undefined（旧客户端未传）= 保留现有；null/空串 = 显式清除（切回存储连接）
    localDir: incoming.localDir === undefined
      ? (existing.localDir ?? null)
      : (incoming.localDir?.trim() || null),
    prefix: normalizeBackupPrefix(incoming.prefix),
    retentionDays: Math.max(1, incoming.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS),
  }
}

export function normalizeBackupPrefix(prefix?: string): string {
  if (!prefix) return ''
  const p = prefix.replace(/^\/+/, '').replace(/\/+$/, '')
  return p === '' ? '' : `${p}/`
}

/** 备份对象键：{prefix}snapshots/{iso}-{id}.db */
export function buildSnapshotObjectKey(prefix: string, id: string, at = new Date()): string {
  const iso = at.toISOString().replace(/[:.]/g, '-')
  return `${normalizeBackupPrefix(prefix)}snapshots/${iso}-${id}.db`
}

export function buildManifestObjectKey(dbObjectKey: string): string {
  return dbObjectKey.replace(/\.db$/i, '') + '.manifest.json'
}

export function assertSchemaCompatible(backupSchemaVersion: number, current = CURRENT_SCHEMA_VERSION): void {
  if (!Number.isInteger(backupSchemaVersion) || backupSchemaVersion < 1) {
    throw new Error(`无效的 schema 版本: ${backupSchemaVersion}`)
  }
  if (backupSchemaVersion > current) {
    throw new Error(
      `备份 schema 版本 ${backupSchemaVersion} 高于当前程序支持的 ${current}，请先升级 NoteFast`,
    )
  }
}

export const backupConfigSchema = z.object({
  enabled: z.boolean(),
  locationId: z.string().nullable(),
  localDir: z.string().max(500).nullable().optional(),
  prefix: z.string().optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
})

export function isBackupManifest(value: unknown): value is BackupManifest {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return (
    m.app === 'notefast' &&
    m.kind === 'sqlite-snapshot' &&
    m.version === 1 &&
    typeof m.createdAt === 'string' &&
    typeof m.objectKey === 'string' &&
    typeof m.sizeBytes === 'number' &&
    typeof m.sha256 === 'string' &&
    typeof m.schemaVersion === 'number'
  )
}
