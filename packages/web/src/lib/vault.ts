/**
 * vault mode 的前端契约（只读）。
 *
 * 对应 `GET /api/v1/vault/status`（RFC 0001 D4）与 `GET /api/v1/docs/:id` 上
 * 仅 vault 文档才有的 `vault_path` 字段（V-401）。样式/组件无关，便于单测。
 */

/** 一次对账的统计（`ReconcileStats`，`POST /vault/rebuild` 与 `last_reconcile` 同形） */
export interface VaultReconcileStats {
  totalFiles: number
  created: number
  updated: number
  unchanged: number
  restored: number
  moved: number
  deleted: number
  errors: Array<{ relPath: string; error: string }>
  durationMs: number
}

/** `GET /api/v1/vault/status`：未启用时只有 `{ enabled: false }` */
export interface VaultStatus {
  enabled: boolean
  root?: string
  notebook_id?: string
  watch?: boolean
  writeback?: boolean
  use_polling?: boolean
  watcher_active?: boolean
  reconciling?: boolean
  files?: number
  last_reconcile?: VaultReconcileStats | null
  conflicts?: { count: number; paths: string[] }
}

/**
 * vault 是否启用。只有服务端明确回 `enabled: true` 才算启用：
 * 加载中 / 未启用 / 请求失败（data 为 null）一律视为未启用，
 * 设置页入口与面板据此整体隐藏，不出现错误墙。
 */
export function isVaultEnabled(status: VaultStatus | null | undefined): status is VaultStatus {
  return status?.enabled === true
}

/** 最近冲突副本路径（服务端已截断为最近 10 条，这里再兜底） */
export function recentConflictPaths(status: VaultStatus | null | undefined, limit = 10): string[] {
  const paths = status?.conflicts?.paths
  return Array.isArray(paths) ? paths.slice(0, limit) : []
}

/** 对账错误条数（`last_reconcile` 缺失时为 0） */
export function reconcileErrorCount(status: VaultStatus | null | undefined): number {
  return status?.last_reconcile?.errors?.length ?? 0
}

/**
 * 文档的来源文件路径：只有 vault 文档带 `vault_path`，db notebook 无该字段。
 * 入参是 `GET /docs/:id` 的响应（`Block` + 可选 `vault_path`），用 unknown 收口避免弱类型检查。
 */
export function vaultPathOf(doc: unknown): string | null {
  if (typeof doc !== 'object' || doc === null) return null
  const raw = (doc as { vault_path?: unknown }).vault_path
  return typeof raw === 'string' && raw.trim() ? raw : null
}
