/**
 * 存储连接（Storage Location）领域模型
 *
 * 备份 / 多端同步 / Markdown 归档共用的「连接信息」：bucket/凭据/endpoint 等填一次，
 * 各能力只引用 connectionId + 自己的前缀（目录）。前缀负责隔离，连接只负责「连到哪」。
 *
 * 持久化到 data/storage-locations.json（数组）。
 */

import { z } from 'zod'

export type StorageLocationKind = 's3' | 'webdav'

/** S3 / R2 / MinIO 等兼容对象存储连接 */
export interface S3LocationConfig {
  bucket: string
  region: string
  /** 自定义 endpoint（R2 / MinIO / OSS） */
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
  /** MinIO 自建需要 true */
  forcePathStyle?: boolean
}

/** WebDAV（NextCloud / 群晖 / 坚果云等）连接 */
export interface WebDavLocationConfig {
  endpoint: string
  username: string
  password: string
}

export interface StorageLocation {
  id: string
  name: string
  kind: StorageLocationKind
  s3?: S3LocationConfig
  webdav?: WebDavLocationConfig
}

/** 新建/更新入参：密钥可省略，由 merge 沿用旧值 */
export type S3LocationInput = Omit<S3LocationConfig, 'accessKeyId' | 'secretAccessKey'> & {
  accessKeyId?: string
  secretAccessKey?: string
}
export type WebDavLocationInput = Omit<WebDavLocationConfig, 'username' | 'password'> & {
  username?: string
  password?: string
}
export interface StorageLocationInput {
  id: string
  name: string
  kind: StorageLocationKind
  s3?: S3LocationInput
  webdav?: WebDavLocationInput
}

/** 对外脱敏占位符（与备份/同步同形，UI 复用） */
export const STORAGE_SECRET_MASK = '***set***'

export function publicStorageLocation(loc: StorageLocation): StorageLocation {
  return {
    ...loc,
    s3: loc.s3
      ? {
          ...loc.s3,
          accessKeyId: loc.s3.accessKeyId ? STORAGE_SECRET_MASK : '',
          secretAccessKey: loc.s3.secretAccessKey ? STORAGE_SECRET_MASK : '',
        }
      : undefined,
    webdav: loc.webdav
      ? {
          ...loc.webdav,
          username: loc.webdav.username ? STORAGE_SECRET_MASK : '',
          password: loc.webdav.password ? STORAGE_SECRET_MASK : '',
        }
      : undefined,
  }
}

/** 合并 PUT 与磁盘连接（密钥省略/脱敏时沿用旧值） */
export function mergeStorageLocation(
  incoming: StorageLocationInput,
  existing?: StorageLocation,
): StorageLocation {
  const base: StorageLocation = {
    id: incoming.id,
    name: incoming.name,
    kind: incoming.kind,
  }
  if (incoming.kind === 's3' && incoming.s3) {
    return {
      ...base,
      s3: {
        ...incoming.s3,
        accessKeyId: resolveSecret(incoming.s3.accessKeyId, existing?.s3?.accessKeyId),
        secretAccessKey: resolveSecret(incoming.s3.secretAccessKey, existing?.s3?.secretAccessKey),
      },
    }
  }
  if (incoming.kind === 'webdav' && incoming.webdav) {
    return {
      ...base,
      webdav: {
        ...incoming.webdav,
        username: resolveSecret(incoming.webdav.username, existing?.webdav?.username),
        password: resolveSecret(incoming.webdav.password, existing?.webdav?.password),
      },
    }
  }
  return base
}

function resolveSecret(incoming: string | undefined, existing: string | undefined): string {
  if (incoming === undefined || incoming === STORAGE_SECRET_MASK) return existing ?? ''
  return incoming.trim()
}

// ───────────────────── 校验 ─────────────────────

export const s3LocationSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().min(1),
  endpoint: z.string().optional(),
  // 密钥可省略（已有连接时 UI 不重发，merge 沿用旧值）
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  forcePathStyle: z.boolean().optional(),
})

export const webDavLocationSchema = z.object({
  endpoint: z.string().min(1),
  username: z.string().optional(),
  password: z.string().optional(),
})

export const storageLocationSchema = z.object({
  name: z.string().min(1).max(64),
  kind: z.enum(['s3', 'webdav']),
  s3: s3LocationSchema.optional(),
  webdav: webDavLocationSchema.optional(),
})

/** 连接是否可用（kind 对应的必填字段齐备） */
export function storageLocationReady(loc: StorageLocation): boolean {
  if (loc.kind === 's3') {
    return Boolean(loc.s3?.bucket && loc.s3?.accessKeyId && loc.s3?.secretAccessKey)
  }
  if (loc.kind === 'webdav') {
    return Boolean(loc.webdav?.endpoint)
  }
  return false
}
