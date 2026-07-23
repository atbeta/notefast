/**
 * Sync Manager
 *
 * 单例：负责 sync adapter 的生命周期、配置持久化、状态可观察。
 *
 * 设计原则（与 AiRuntime 对齐）：
 * - 单一 init 入口，从 data/sync.config.json 加载（或环境变量种子）
 * - 热重载 applyConfig(cfg)：切换 adapter / 重置定时器
 * - 状态可序列化：syncStatus() 返回 runtime 视图
 *
 * 自动同步：
 * - cfg.autoSyncIntervalMs > 0 时启动定时器，每隔 N ms 跑一次
 * - 失败不影响下一次；lastError / lastSuccessAt 暴露
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import {
  emptySyncConfig,
  mergeSyncConfig,
  type SyncAdapter,
  type SyncPersistedConfig,
  type SyncInfo,
  type SyncResult,
  type PushOptions,
  publicSyncView,
} from '@notefast/core'
import { createLocalFsAdapter } from './localFs'
import { createS3Adapter } from './s3'
import { createWebDavAdapter } from './webdav'

const CONFIG_FILE = 'sync.config.json'

export interface SyncRuntimeStatus {
  configured: boolean
  adapterName?: string
  enabled: boolean
  lastRunAt?: string
  lastSuccessAt?: string
  lastError?: string
  lastResult?: SyncResult | null
  autoSyncIntervalMs?: number
}

let cfg: SyncPersistedConfig = emptySyncConfig()
let dataDir = ''
let activeAdapter: SyncAdapter | null = null
let lastResult: SyncResult | null = null
let lastRunAt: string | null = null
let lastSuccessAt: string | null = null
let lastError: string | null = null
let autoSyncTimer: ReturnType<typeof setInterval> | null = null
let running = false

/** 启动期初始化 */
export function initSyncManager(dir: string, env?: Record<string, string | undefined>): void {
  dataDir = dir
  cfg = loadOrSeed(env || process.env)
  rebuild()
}

/** 适配器是否已就绪 */
export function isSyncConfigured(): boolean {
  return activeAdapter !== null
}

export function getSyncConfig(): SyncPersistedConfig {
  return cfg
}

export function getSyncPublicConfig(): SyncPersistedConfig {
  return publicSyncView(cfg)
}

export function syncStatus(): SyncRuntimeStatus {
  const a = cfg.active
  return {
    configured: Boolean(activeAdapter),
    adapterName: activeAdapter?.name,
    enabled: Boolean(a?.enabled),
    lastRunAt: lastRunAt ?? undefined,
    lastSuccessAt: lastSuccessAt ?? undefined,
    lastError: lastError ?? undefined,
    lastResult,
    autoSyncIntervalMs: cfg.autoSyncIntervalMs,
  }
}

/** 热重载：更新配置、切换适配器（脱敏密钥沿用磁盘旧值） */
export async function applySyncConfig(newCfg: SyncPersistedConfig): Promise<SyncRuntimeStatus> {
  cfg = mergeSyncConfig(newCfg, cfg)
  saveConfigToDisk(cfg)
  rebuild()
  return syncStatus()
}

/** 探测远端信息 */
export async function syncInfo(): Promise<SyncInfo> {
  if (!activeAdapter) {
    throw new Error('Sync adapter 未配置')
  }
  return activeAdapter.info()
}

/** 手动 / 定时 push（统一走状态记录；禁止重叠） */
export async function syncPush(opts?: PushOptions): Promise<SyncResult> {
  if (!activeAdapter) {
    throw new Error('Sync adapter 未配置')
  }
  if (running) {
    throw Object.assign(new Error('归档任务正在进行中'), { code: 'sync_in_progress' })
  }
  running = true
  lastRunAt = new Date().toISOString()
  try {
    const r = await activeAdapter.push(opts)
    lastResult = r
    if (r.errors.length > 0) {
      lastError = r.errors.join('; ')
    } else {
      lastError = null
      lastSuccessAt = lastRunAt
    }
    return r
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    lastResult = { pushed: 0, pulled: 0, errors: [lastError] }
    throw e
  } finally {
    running = false
  }
}

// ───────────────────── 持久化 ─────────────────────

function loadOrSeed(env: Record<string, string | undefined>): SyncPersistedConfig {
  if (!dataDir) return seedFromEnv(env) ?? emptySyncConfig()
  const path = join(dataDir, CONFIG_FILE)
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(raw) as SyncPersistedConfig
      if (parsed && parsed.version === 1) return parsed
    } catch {
      /* ignore */
    }
  }
  const fromEnv = seedFromEnv(env)
  if (fromEnv) saveConfigToDisk(fromEnv)
  return fromEnv ?? emptySyncConfig()
}

function seedFromEnv(env: Record<string, string | undefined>): SyncPersistedConfig | null {
  const dir = (env.SYNC_LOCAL_DIR || env.AUTO_EXPORT_DIR || '').trim()
  if (dir) {
    const interval = parseInt(env.SYNC_AUTO_INTERVAL_MS || '3600000', 10)
    return {
      version: 1,
      active: { kind: 'localfs', dir, enabled: true },
      autoSyncIntervalMs: Number.isFinite(interval) && interval >= 0 ? interval : 3600_000,
    }
  }
  return null
}

export function loadConfigFromDisk(): SyncPersistedConfig {
  if (!dataDir) return emptySyncConfig()
  try {
    const raw = readFileSync(join(dataDir, CONFIG_FILE), 'utf-8')
    return JSON.parse(raw) as SyncPersistedConfig
  } catch {
    return emptySyncConfig()
  }
}

export function saveConfigToDisk(c: SyncPersistedConfig): void {
  if (!dataDir) throw new Error('dataDir 未初始化')
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, CONFIG_FILE), JSON.stringify(c, null, 2) + '\n', 'utf-8')
  try { chmodSync(join(dataDir, CONFIG_FILE), 0o600) } catch { /* Windows 不支持 */ }
}

// ───────────────────── 适配器工厂 ─────────────────────

function createAdapter(ac: SyncPersistedConfig['active']): SyncAdapter | null {
  if (!ac) return null
  if (!ac.enabled) return null
  if (ac.kind === 'localfs') return createLocalFsAdapter(ac)
  if (ac.kind === 's3') return createS3Adapter(ac)
  if (ac.kind === 'webdav') return createWebDavAdapter(ac)
  throw new Error(`未知 adapter kind: ${(ac as { kind?: string }).kind ?? 'undefined'}`)
}

function rebuild(): void {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer)
    autoSyncTimer = null
  }
  activeAdapter = null
  lastError = null
  try {
    activeAdapter = createAdapter(cfg.active)
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    console.error('🔄 Sync adapter 初始化失败:', lastError)
    return
  }
  if (activeAdapter) {
    console.log(`🔄 Sync adapter: ${activeAdapter.name}`)
  }
  if (cfg.autoSyncIntervalMs && cfg.autoSyncIntervalMs > 0 && activeAdapter) {
    autoSyncTimer = setInterval(() => {
      // 统一走 syncPush，确保 lastRunAt / lastError / lastResult 更新
      syncPush().catch((err) => {
        console.warn('[sync] auto push failed:', err instanceof Error ? err.message : err)
      })
    }, cfg.autoSyncIntervalMs)
    if (!process.env.SYNC_QUIET) {
      console.log(`🔄 Sync auto interval: ${cfg.autoSyncIntervalMs}ms`)
    }
  }
}

// 测试钩子：清空全部状态
export function _resetForTests(): void {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer)
    autoSyncTimer = null
  }
  cfg = emptySyncConfig()
  dataDir = ''
  activeAdapter = null
  lastResult = null
  lastRunAt = null
  lastSuccessAt = null
  lastError = null
  running = false
}
