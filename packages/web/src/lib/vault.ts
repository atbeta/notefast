/**
 * vault mode 的前端契约（只读）。
 *
 * 对应 `GET /api/v1/vault/status`（RFC 0001 D4）与 `GET /api/v1/docs/:id` 上
 * 仅 vault 文档才有的 `vault_path` 字段（V-401）。样式/组件无关，便于单测。
 */

import type { StorageLocation } from '@notefast/core'

/** 一次对账的统计（`ReconcileStats`，`POST /vault/rebuild` 与 `last_reconcile` 同形） */
export interface VaultReconcileStats {
  totalFiles: number
  created: number
  updated: number
  unchanged: number
  restored: number
  moved: number
  deleted: number
  /** 轻量对账里「size + mtime 未变、跳过读盘」的文件数 */
  stat_skipped?: number
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
  /** 下一次定时轻量对账时间（ISO）；未开启定时对账时为 null */
  next_reconcile_at?: string | null
  /** 文件同步（RFC 0004）状态；旧服务端可能没有该字段 */
  sync?: VaultSyncStatus
}

/** 一次 push 的统计（服务端 `VaultPushResult`） */
export interface VaultPushResult {
  scanned: number
  /** 内容有变化、已写入远端清单的文件数 */
  changed: number
  uploaded_blobs: number
  tombstones: number
  /** 只 mtime 变、内容未变的文件（刷新基线，不产生远端条目） */
  touched_only: number
}

/** 一次 pull 的统计（服务端 `VaultPullResult`） */
export interface VaultPullResult {
  remote_entries: number
  /** 落盘（新建或快进覆盖）的文件数 */
  applied: number
  /** 删除并移入 .trash 的文件数 */
  deleted: number
  unchanged: number
  /** 冲突副本的 vault 相对路径 */
  conflicts: string[]
  /** 远端 blob 缺失等异常 */
  errors: string[]
}

/** 文件同步状态（`GET /api/v1/vault/status` 的 `sync`，RFC 0004） */
export interface VaultSyncStatus {
  enabled: boolean
  /** 配置完整且能建出 store */
  configured: boolean
  /** 人类可读的同步目标（不含凭据） */
  target: string | null
  prefix: string
  interval_seconds: number
  vault_id: string | null
  device_id: string
  last_push_at: string | null
  last_pull_at: string | null
  last_error: string | null
  last_push: VaultPushResult | null
  last_pull: VaultPullResult | null
  /** 同步基线里的文件数（上次同步过多少文件） */
  tracked_files: number
  /** 下一次定时同步时间（ISO）；未开启定时同步为 null */
  next_run_at: string | null
  /** 同步服务已启动（vault 模式下恒为 true） */
  running: boolean
  /** 此刻是否有一次 push / pull 在跑 */
  in_flight?: boolean
  /** 第三方同步工具痕迹（iCloud / Dropbox / Syncthing / sync-conflict） */
  foreign_sync_hints?: string[]
}

/** `GET /api/v1/vault/sync/config` 的响应（表单回填用） */
export interface VaultFileSyncConfigView {
  enabled: boolean
  locationId: string | null
  localDir: string
  prefix: string
  intervalSeconds: number
}

/** 同步配置表单（字符串态，便于直接绑 Input） */
export interface VaultSyncFormState {
  enabled: boolean
  locationId: string
  localDir: string
  prefix: string
  intervalSeconds: string
}

/** `PUT /api/v1/vault/sync/config` 的入参（服务端 `VaultFileSyncConfigInput`） */
export interface VaultSyncConfigPayload {
  enabled: boolean
  locationId: string | null
  localDir: string
  prefix: string
  intervalSeconds: number
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

// ───────────────────── 文件同步（RFC 0004 P3） ─────────────────────

/** 同步状态块（旧服务端 / 未启用时返回 null） */
export function syncStatusOf(status: VaultStatus | null | undefined): VaultSyncStatus | null {
  return status?.sync ?? null
}

/** 同步目标是否可用（配置完整且能建出 store）——不可用时推送/拉取会失败 */
export function syncConfigured(status: VaultStatus | null | undefined): boolean {
  return status?.sync?.configured === true
}

/** 同步开关是否打开 */
export function syncEnabled(status: VaultStatus | null | undefined): boolean {
  return status?.sync?.enabled === true
}

/**
 * 同步服务（调度器）是否已启动。
 *
 * 注意：服务端 `running` 表示 `fileSync.start()` 已经跑过（vault 模式下恒为 true），
 * **不是**「有一次 push / pull 在跑」——单次运行中的状态只有本地请求态能反映。
 */
export function syncServiceRunning(status: VaultStatus | null | undefined): boolean {
  return status?.sync?.running === true
}

/** 最近一次拉取的冲突副本数（`last_pull` 缺失时为 0） */
export function syncConflictCount(status: VaultStatus | null | undefined): number {
  return status?.sync?.last_pull?.conflicts?.length ?? 0
}

/** 同步目标标签（`local:<dir>` / `s3://<bucket>/<prefix>` / `webdav:<endpoint>/<prefix>`）；未配置为 null */
export function syncTargetLabel(status: VaultStatus | null | undefined): string | null {
  const target = status?.sync?.target
  return typeof target === 'string' && target.trim() ? target : null
}

/** LocalFS 目标的本地目录（从 `target` 反解；非 LocalFS 返回 ''） */
export function syncLocalDirOf(status: VaultStatus | null | undefined): string {
  const target = syncTargetLabel(status)
  return target?.startsWith('local:') ? target.slice('local:'.length) : ''
}

/**
 * 同步目标对应的存储连接 id。
 *
 * 服务端 `sync` 状态只给人类可读的 `target`（不含 locationId），这里按
 * bucket / endpoint 反查 `storage-locations` 列表，用于把下拉框预选回原连接；
 * 反查不到（连接已删除、LocalFS 目标）返回 ''。
 */
export function syncTargetLocationId(
  status: VaultStatus | null | undefined,
  locations: readonly StorageLocation[],
): string {
  const target = syncTargetLabel(status)
  if (!target) return ''
  let best: { id: string; len: number } | null = null
  for (const loc of locations) {
    const probe =
      loc.kind === 's3' && loc.s3?.bucket
        ? `s3://${loc.s3.bucket}/`
        : loc.kind === 'webdav' && loc.webdav?.endpoint
          ? `webdav:${loc.webdav.endpoint}/`
          : ''
    if (!probe || !target.startsWith(probe)) continue
    if (!best || probe.length > best.len) best = { id: loc.id, len: probe.length }
  }
  return best?.id ?? ''
}

/** 状态 → 表单初值（未启用 / 旧服务端按空表单 + 60 秒兜底） */
export function syncFormFromStatus(
  status: VaultStatus | null | undefined,
  locations: readonly StorageLocation[] = [],
): VaultSyncFormState {
  const sync = syncStatusOf(status)
  return {
    enabled: sync?.enabled === true,
    locationId: syncTargetLocationId(status, locations),
    localDir: syncLocalDirOf(status),
    // 服务端归一化后的前缀带尾斜杠，回填表单时去掉
    prefix: (sync?.prefix ?? '').replace(/\/+$/, ''),
    intervalSeconds: String(sync?.interval_seconds ?? 60),
  }
}

/** 表单里的间隔秒数 → 入参：空 / 非法 / 负数一律 0（= 只手动或仅文件变更时推送） */
export function parseSyncIntervalSeconds(raw: string): number {
  const n = Number(raw.trim())
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** 表单 → `PUT /vault/sync/config` 入参 */
export function syncConfigPayload(form: VaultSyncFormState): VaultSyncConfigPayload {
  return {
    enabled: form.enabled,
    locationId: form.locationId.trim() || null,
    localDir: form.localDir.trim(),
    prefix: form.prefix.trim(),
    intervalSeconds: parseSyncIntervalSeconds(form.intervalSeconds),
  }
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

// ───────────────────── vault 内资源路径解析（V-303） ─────────────────────

/** 可直出的资源扩展名（与服务端 `VAULT_ASSET_MIME` 对齐） */
const VAULT_ASSET_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'])

/** 去掉 Obsidian 别名（`|`）与锚点（`#`）后的资源名 */
function embedName(raw: string): string {
  return raw.trim().split('|')[0]!.split('#')[0]!.trim()
}

/** 是否是可直出的 vault 资源名（按扩展名判断） */
export function isVaultAssetName(name: string): boolean {
  const clean = embedName(name)
  if (!clean.includes('.')) return false
  return VAULT_ASSET_EXT.has(clean.split('.').pop()!.toLowerCase())
}

/** 以 `baseDir` 为基准拼接相对路径，处理 `.` / `..`；越出 vault 根返回 null */
function joinRelPath(baseDir: string, rel: string): string | null {
  const parts = [...(baseDir ? baseDir.split('/') : []), ...rel.split('/')]
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.length > 0 ? out.join('/') : null
}

function rawUrl(relPath: string): string {
  return `/api/v1/vault/raw/${relPath.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Markdown 图片的相对路径 → vault raw API。
 * - 只在 vault 文档里生效（没有 `vaultPath` 时返回 null，调用方保留原 src）
 * - 绝对路径 / 协议 URL / `asset:` 引用一律不接管（db notebook 语义不变）
 * - 基准是**文档所在目录**：`notes/sub/doc.md` 里的 `assets/x.png` → `notes/sub/assets/x.png`
 * - 越界（`../../`）或非资源扩展名返回 null
 */
export function resolveVaultAssetSrc(rawSrc: string, vaultPath: string | null | undefined): string | null {
  if (!vaultPath) return null
  const src = rawSrc.trim()
  if (!src || src.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(src)) return null
  if (!isVaultAssetName(src)) return null
  const dir = vaultPath.includes('/') ? vaultPath.slice(0, vaultPath.lastIndexOf('/')) : ''
  const rel = joinRelPath(dir, src)
  return rel ? rawUrl(rel) : null
}

/**
 * Obsidian 嵌入 `![[x.png]]` → vault raw API。
 * 只给文件名，服务端按「全 vault 唯一 basename」回退（Obsidian 规则）。
 */
export function resolveVaultEmbedSrc(raw: string, vaultPath: string | null | undefined): string | null {
  if (!vaultPath) return null
  const name = embedName(raw)
  if (!name || !isVaultAssetName(name)) return null
  return rawUrl(name)
}

/** 由配置接口直接构造表单（优于从 target 反解） */
export function syncFormFromConfig(cfg: VaultFileSyncConfigView): VaultSyncFormState {
  return {
    enabled: cfg.enabled === true,
    locationId: cfg.locationId ?? '',
    localDir: cfg.localDir ?? '',
    prefix: cfg.prefix ?? '',
    intervalSeconds: String(cfg.intervalSeconds ?? 60),
  }
}
