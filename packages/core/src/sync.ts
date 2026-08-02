/**
 * 数据同步适配器接口
 *
 * 设计原则：
 * - 数据主权：用户数据始终能用 Markdown 格式完整导出
 * - 适配器不绑定特定后端，实现该接口即可接入
 * - 生命周期钩子可在 sync 前后注入自定义逻辑
 */

import { z } from 'zod'

export type SyncAdapterKind = 'localfs' | 's3' | 'webdav'

export interface LocalFsAdapterConfig {
  kind: 'localfs'
  /** 导出目录；不存在会自动创建 */
  dir: string
  /** 文件名前缀（可选） */
  prefix?: string
  /** 启用 */
  enabled: boolean
}

export interface S3AdapterConfig {
  kind: 's3'
  /** 桶名 */
  bucket: string
  /** 区域 */
  region: string
  /** 自定义 endpoint（MinIO / R2 / 阿里云 OSS） */
  endpoint?: string
  /** 凭证 */
  accessKeyId: string
  secretAccessKey: string
  /** key 前缀 */
  prefix?: string
  /** MinIO 自建需要 true */
  forcePathStyle?: boolean
  enabled: boolean
}

export interface WebDavAdapterConfig {
  /** WebDAV 端点（绝对 URL） */
  kind: 'webdav'
  /** 例如：https://dav.example.com/remote.php/webdav 或 https://nas.local/dav/ */
  endpoint: string
  username: string
  password: string
  /** 远端路径前缀（可选），如 'notes' */
  prefix?: string
  /** 第一次推送时是否需要认证 challenge（Basic Auth 默认 true） */
  enabled: boolean
}

export type SyncAdapterConfig = LocalFsAdapterConfig | S3AdapterConfig | WebDavAdapterConfig

/** 持久化到磁盘的 sync 配置 */
export interface SyncPersistedConfig {
  version: 1
  active: SyncAdapterConfig | null
  /** 自动同步间隔（毫秒）；0 或 undefined 表示关闭 */
  autoSyncIntervalMs?: number
}

export interface SyncInfo {
  /** 远端最后同步时间 */
  lastSyncAt?: string
  /** 远端文档数量（如能获取） */
  remoteDocCount?: number
  /** 适配器特定状态 */
  extra?: Record<string, unknown>
}

export interface SyncResult {
  /** 上传的文档数 */
  pushed: number
  /** 拉取的文档数（暂不实现双向同步，返回 0） */
  pulled: number
  /** 错误信息 */
  errors: string[]
}

export interface SyncAdapter {
  /** 适配器名称，如 'localfs' / 's3' / 'webdav' */
  readonly name: string

  /** 检查连接和远端状态 */
  info(): Promise<SyncInfo>

  /** 将本地变更推送到远端 */
  push(options?: PushOptions): Promise<SyncResult>

  /** 从远端拉取变更（预留，v0.1.0 仅实现单向导出） */
  pull?(options?: PullOptions): Promise<SyncResult>
}

export interface PushOptions {
  /** 仅导出 Markdown（不包含数据库文件） */
  markdownOnly?: boolean
  /** 导出的文档 ID 列表（不传则全部） */
  docIds?: string[]
  /** 目标路径前缀 */
  prefix?: string
}

export interface PullOptions {
  /** 拉取后是否覆盖本地已有文档 */
  overwrite?: boolean
  /** 来源路径前缀 */
  prefix?: string
}

/** 内建的适配器工厂签名 */
export type SyncAdapterFactory = (config: Record<string, string>) => SyncAdapter

export const SYNC_SECRET_MASK = '***set***'

export function emptySyncConfig(): SyncPersistedConfig {
  return { version: 1, active: null }
}

function resolveSecret(incoming: string | undefined, existing: string | undefined): string {
  if (incoming === undefined || incoming === SYNC_SECRET_MASK) return existing ?? ''
  return incoming.trim()
}

/** 合并 PUT 配置与磁盘配置（脱敏密钥沿用旧值） */
export function mergeSyncConfig(
  incoming: SyncPersistedConfig,
  existing: SyncPersistedConfig,
): SyncPersistedConfig {
  const next: SyncPersistedConfig = {
    version: 1,
    active: incoming.active,
    autoSyncIntervalMs: incoming.autoSyncIntervalMs,
  }
  if (!next.active) return next
  const prev = existing.active
  if (next.active.kind === 's3') {
    const prevS3 = prev?.kind === 's3' ? prev : null
    next.active = {
      ...next.active,
      accessKeyId: resolveSecret(next.active.accessKeyId, prevS3?.accessKeyId),
      secretAccessKey: resolveSecret(next.active.secretAccessKey, prevS3?.secretAccessKey),
    }
  } else if (next.active.kind === 'webdav') {
    const prevDav = prev?.kind === 'webdav' ? prev : null
    next.active = {
      ...next.active,
      username: resolveSecret(next.active.username, prevDav?.username),
      password: resolveSecret(next.active.password, prevDav?.password),
    }
  }
  return next
}

/** 对外展示时移除密钥 */
export function publicSyncView(cfg: SyncPersistedConfig): SyncPersistedConfig {
  if (!cfg.active) return cfg
  if (cfg.active.kind === 's3') {
    return {
      ...cfg,
      active: {
        ...cfg.active,
        accessKeyId: cfg.active.accessKeyId ? SYNC_SECRET_MASK : '',
        secretAccessKey: cfg.active.secretAccessKey ? SYNC_SECRET_MASK : '',
      },
    }
  }
  if (cfg.active.kind === 'webdav') {
    return {
      ...cfg,
      active: {
        ...cfg.active,
        username: cfg.active.username ? SYNC_SECRET_MASK : '',
        password: cfg.active.password ? SYNC_SECRET_MASK : '',
      },
    }
  }
  return cfg
}

// ───────────────────── 多端同步协议（双向增量）独立配置 ─────────────────────
// 与「数据库备份」完全解耦：各自独立的 S3 配置、开关与调度。

export interface SyncProtocolS3Config {
  /** 桶名 */
  bucket: string
  /** 区域 */
  region: string
  /** 自定义 endpoint（MinIO / R2 / 阿里云 OSS） */
  endpoint?: string
  /** 凭证 */
  accessKeyId: string
  secretAccessKey: string
  /** 对象键前缀；归一化后带尾斜杠 */
  prefix?: string
  /** MinIO 自建需要 true */
  forcePathStyle?: boolean
}

/** 持久化到 data/sync-protocol.config.json */
export interface SyncProtocolPersistedConfig {
  version: 1
  enabled: boolean
  s3: SyncProtocolS3Config | null
}

/** PUT 入参的 s3 片段：密钥可省略，由 merge 沿用旧值 */
export type SyncProtocolS3Input = Omit<SyncProtocolS3Config, 'accessKeyId' | 'secretAccessKey'> & {
  accessKeyId?: string
  secretAccessKey?: string
}

/** mergeSyncProtocolConfig / applyProtocolConfig 入参形态（仅 s3 密钥可省略） */
export type SyncProtocolConfigInput = Omit<SyncProtocolPersistedConfig, 's3'> & {
  s3: SyncProtocolS3Input | null
}

export function emptySyncProtocolConfig(): SyncProtocolPersistedConfig {
  return { version: 1, enabled: false, s3: null }
}

export function normalizeSyncProtocolPrefix(prefix?: string): string {
  if (!prefix) return ''
  const p = prefix.replace(/^\/+/, '').replace(/\/+$/, '')
  return p === '' ? '' : `${p}/`
}

/** 合并 PUT 配置与磁盘配置（密钥省略/脱敏时沿用旧值；前缀归一化） */
export function mergeSyncProtocolConfig(
  incoming: SyncProtocolConfigInput,
  existing: SyncProtocolPersistedConfig,
): SyncProtocolPersistedConfig {
  const prevS3 = existing.s3
  const nextS3: SyncProtocolS3Config | null = incoming.s3
    ? {
        ...incoming.s3,
        accessKeyId: resolveSecret(incoming.s3.accessKeyId, prevS3?.accessKeyId),
        secretAccessKey: resolveSecret(incoming.s3.secretAccessKey, prevS3?.secretAccessKey),
        prefix: normalizeSyncProtocolPrefix(incoming.s3.prefix),
      }
    : null
  return {
    version: 1,
    enabled: incoming.enabled,
    s3: nextS3,
  }
}

/** 对外展示时移除密钥 */
export function publicSyncProtocolView(cfg: SyncProtocolPersistedConfig): SyncProtocolPersistedConfig {
  if (!cfg.s3) return cfg
  return {
    ...cfg,
    s3: {
      ...cfg.s3,
      accessKeyId: cfg.s3.accessKeyId ? SYNC_SECRET_MASK : '',
      secretAccessKey: cfg.s3.secretAccessKey ? SYNC_SECRET_MASK : '',
    },
  }
}

export const syncProtocolS3ConfigSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().min(1),
  endpoint: z.string().optional(),
  // 密钥可省略（已有配置时 UI 不重发，merge 沿用旧值）
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  prefix: z.string().optional(),
  forcePathStyle: z.boolean().optional(),
})

export const syncProtocolConfigSchema = z.object({
  enabled: z.boolean(),
  s3: syncProtocolS3ConfigSchema.nullable(),
})
