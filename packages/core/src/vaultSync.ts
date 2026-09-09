/**
 * vault 文件同步（NoteFast Sync for files，RFC 0004）的共享类型与配置归一化。
 *
 * 只放「跨端契约」：远端清单条目、本端配置。实现分别在
 * `server/src/vault/fileSync.ts`（引擎）与 `server/src/vault/fileSyncConfig.ts`（持久化）。
 */

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
}

export type VaultFileSyncConfigInput = Omit<VaultFileSyncConfig, 'version'>

export function emptyVaultFileSyncConfig(): VaultFileSyncConfig {
  return { version: 1, enabled: false, locationId: null, localDir: '', prefix: '', intervalSeconds: 60 }
}

export function normalizeVaultSyncPrefix(prefix?: string | null): string {
  if (!prefix) return ''
  const p = prefix.replace(/^\/+/, '').replace(/\/+$/, '')
  return p === '' ? '' : `${p}/`
}

export function mergeVaultFileSyncConfig(
  incoming: VaultFileSyncConfigInput,
  _existing: VaultFileSyncConfig,
): VaultFileSyncConfig {
  const interval = Number.isFinite(incoming.intervalSeconds) ? Math.round(incoming.intervalSeconds) : 60
  return {
    version: 1,
    enabled: incoming.enabled === true,
    locationId: incoming.locationId ?? null,
    localDir: (incoming.localDir ?? '').trim(),
    prefix: normalizeVaultSyncPrefix(incoming.prefix),
    intervalSeconds: interval >= 0 ? interval : 60,
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
