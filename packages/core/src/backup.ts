/**
 * 数据库备份领域模型
 *
 * 与 Markdown 归档（sync）完全独立：
 * - 备份：SQLite 一致快照 → S3 不可变恢复点
 * - 归档：文档 Markdown 单向推送
 */

import { z } from 'zod'

/** 对外脱敏占位符（与 AI KEY_MASK 同形，便于 UI 复用） */
export const BACKUP_SECRET_MASK = '***set***'

/** 当前程序支持的最高 schema 版本；恢复时备份版本不得高于此值 */
export const CURRENT_SCHEMA_VERSION = 2

/** 默认备份间隔：1 小时 */
export const DEFAULT_BACKUP_INTERVAL_MS = 3_600_000

/** 默认保留天数 */
export const DEFAULT_BACKUP_RETENTION_DAYS = 30

export interface BackupS3Config {
  bucket: string
  region: string
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
  /** 对象键前缀，如 notefast-backup/；归一化后带尾斜杠 */
  prefix?: string
  forcePathStyle?: boolean
}

/** 持久化到 data/backup.config.json */
export interface BackupPersistedConfig {
  version: 1
  enabled: boolean
  s3: BackupS3Config | null
  /** 自动备份间隔（毫秒）；0 表示仅手动 */
  intervalMs: number
  /** 保留天数；超过后删除 NoteFast 管理的恢复点 */
  retentionDays: number
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
  intervalMs: number
  retentionDays: number
  nextRunAt?: string
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
    s3: null,
    intervalMs: DEFAULT_BACKUP_INTERVAL_MS,
    retentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
  }
}

/** 解析保存时的密钥：脱敏占位符 → 保留旧值；undefined → 保留旧值 */
export function resolveBackupSecret(
  incoming: string | undefined,
  existing: string | undefined,
): string {
  if (incoming === undefined || incoming === BACKUP_SECRET_MASK) return existing ?? ''
  return incoming.trim()
}

export function publicBackupView(cfg: BackupPersistedConfig): BackupPersistedConfig {
  if (!cfg.s3) return cfg
  return {
    ...cfg,
    s3: {
      ...cfg.s3,
      accessKeyId: cfg.s3.accessKeyId ? BACKUP_SECRET_MASK : '',
      secretAccessKey: cfg.s3.secretAccessKey ? BACKUP_SECRET_MASK : '',
    },
  }
}

/** 合并 PUT 请求与磁盘配置（密钥省略/脱敏时沿用旧值） */
export function mergeBackupConfig(
  incoming: BackupPersistedConfig,
  existing: BackupPersistedConfig,
): BackupPersistedConfig {
  const prevS3 = existing.s3
  let nextS3 = incoming.s3
  if (nextS3) {
    nextS3 = {
      ...nextS3,
      accessKeyId: resolveBackupSecret(nextS3.accessKeyId, prevS3?.accessKeyId),
      secretAccessKey: resolveBackupSecret(nextS3.secretAccessKey, prevS3?.secretAccessKey),
      prefix: normalizeBackupPrefix(nextS3.prefix),
    }
  }
  return {
    version: 1,
    enabled: incoming.enabled,
    s3: nextS3,
    intervalMs: Math.max(0, incoming.intervalMs ?? DEFAULT_BACKUP_INTERVAL_MS),
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

export const backupS3ConfigSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().min(1),
  endpoint: z.string().optional(),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  prefix: z.string().optional(),
  forcePathStyle: z.boolean().optional(),
})

export const backupConfigSchema = z.object({
  enabled: z.boolean(),
  s3: backupS3ConfigSchema.nullable(),
  intervalMs: z.number().int().min(0).max(86_400_000).optional(),
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
