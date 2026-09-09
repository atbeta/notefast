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
