/**
 * vault 文件同步（NoteFast Sync for files，RFC 0004）的共享类型与配置归一化。
 *
 * 只放「跨端契约」：远端清单条目、本端配置。实现分别在
 * `server/src/vault/fileSync.ts`（引擎）与 `server/src/vault/fileSyncConfig.ts`（持久化）。
 */

import { z } from 'zod'

/** 远端清单里的一条记录（按设备分片存放，读时合并） */
export interface VaultSyncEntry {
  /** vault 相对路径（POSIX 分隔符） */
  rel_path: string
  /** 文件内容 sha256；null = 该端已删除（tombstone） */
  blob: string | null
  size: number
  mtime_ms: number
  /** 文件最后修改时间（ISO8601）；合并时用它裁决谁更新 */
  updated_at: string
  /** 写入该条目的设备 id */
  device_id: string
}

/** 每个设备的清单分片 */
export interface VaultSyncShard {
  version: 1
  device_id: string
  updated_at: string
  entries: VaultSyncEntry[]
}

/** 远端 vault 身份（防串库） */
export interface VaultSyncMeta {
  version: 1
  vault_id: string
  created_at: string
}

export interface VaultFileSyncConfig {
  version: 1
  enabled: boolean
  /** storage-locations.json 里的连接 id；localDir 非空时优先用本地目录 */
  locationId: string | null
  /** LocalFS 目标目录（调试 / 单机多实例） */
  localDir: string
  /** 对象键前缀（归一化后带尾斜杠，空串 = 根） */
  prefix: string
  /** 定时 pull 间隔（秒）；0 = 只手动 / 只在文件变更时 push */
  intervalSeconds: number
  /**
   * 本 vault 的稳定身份（远端 meta.json 用它防串库）；null = 尚未生成。
   * 由引擎维护，API 入参不覆盖（见 merge）。
   */
  vaultId: string | null
}

export interface VaultFileSyncConfigInput {
  enabled: boolean
  locationId: string | null
  localDir?: string
  prefix?: string
  intervalSeconds?: number
}

export function emptyVaultFileSyncConfig(): VaultFileSyncConfig {
  return {
    version: 1,
    enabled: false,
    locationId: null,
    localDir: '',
    prefix: '',
    intervalSeconds: 60,
    vaultId: null,
  }
}

export function normalizeVaultSyncPrefix(prefix?: string | null): string {
  if (!prefix) return ''
  const p = prefix.replace(/^\/+/, '').replace(/\/+$/, '')
  return p === '' ? '' : `${p}/`
}

export function mergeVaultFileSyncConfig(
  incoming: VaultFileSyncConfigInput,
  existing: VaultFileSyncConfig,
): VaultFileSyncConfig {
  const rawInterval = incoming.intervalSeconds
  const interval = rawInterval !== undefined && Number.isFinite(rawInterval) ? Math.round(rawInterval) : 60
  return {
    version: 1,
    enabled: incoming.enabled === true,
    locationId: incoming.locationId ?? null,
    localDir: (incoming.localDir ?? '').trim(),
    prefix: normalizeVaultSyncPrefix(incoming.prefix),
    intervalSeconds: interval >= 0 ? interval : 60,
    // 身份只由引擎维护：换存储目标不换 vault id
    vaultId: existing.vaultId,
  }
}

/** 对外展示（无密钥，原样返回） */
export function publicVaultFileSyncView(cfg: VaultFileSyncConfig): VaultFileSyncConfig {
  return cfg
}

/** 合并规则：`updated_at` 大者胜，相同则 `device_id` 字典序大者胜（确定性） */
export function isNewerVaultSyncEntry(candidate: VaultSyncEntry, current: VaultSyncEntry): boolean {
  if (candidate.updated_at !== current.updated_at) return candidate.updated_at > current.updated_at
  return candidate.device_id > current.device_id
}

/** PUT /api/v1/vault/sync/config 的入参（vaultId 由引擎维护，不接受客户端覆盖） */
export const vaultFileSyncConfigSchema = z.object({
  enabled: z.boolean(),
  locationId: z.string().nullable(),
  localDir: z.string().optional(),
  prefix: z.string().optional(),
  intervalSeconds: z.number().optional(),
})
