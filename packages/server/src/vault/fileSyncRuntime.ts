/**
 * vault 文件同步运行时（RFC 0004 P2）
 *
 * 职责：解析存储目标（LocalFS / S3 / WebDAV）→ 调度 push / pull → 暴露状态。
 * 引擎在 `fileSync.ts`（纯文件层），这里只管「什么时候跑、用什么 store、状态给谁看」。
 */

import type { VaultFileSyncConfig, VaultFileSyncConfigInput } from '@notefast/core'
import { getDeviceId } from '../sync/protocolManager'
import { getStorageLocation } from '../storage/locations'
import { createS3ObjectStore, type ObjectStore } from '../storage/objectStore'
import { createLocalFsObjectStore, createWebDavObjectStore } from '../storage/webdavStore'
import type { VaultContext } from './ingest'
import { applyVaultFileSyncConfig, getVaultFileSyncConfig, setVaultSyncVaultId } from './fileSyncConfig'
import {
  ensureVaultSyncMeta,
  listSyncableFiles,
  pullVaultFiles,
  pushVaultFiles,
  type VaultPullResult,
  type VaultPushResult,
} from './fileSync'
import { listVaultSyncState } from '../store/vaultSyncState'

/** push 去抖：一次保存往往触发多个 fs 事件 */
const PUSH_DEBOUNCE_MS = 3_000

export interface VaultFileSyncStatus {
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
  /** 同步基线里的文件数（= 上次同步过多少文件） */
  tracked_files: number
  /** 下一次定时同步时间（ISO）；未启用定时同步为 null */
  next_run_at: string | null
  running: boolean
}

export interface VaultFileSync {
  start: () => void
  stop: () => void
  push: () => Promise<VaultPushResult>
  pull: () => Promise<VaultPullResult>
  status: () => VaultFileSyncStatus
  applyConfig: (input: VaultFileSyncConfigInput) => VaultFileSyncStatus
  /** 文件变更后调用（去抖 push） */
  notifyFileChange: () => void
}

interface ResolvedTarget {
  store: ObjectStore
  target: string
}

/** 由配置解析出 store；配置不完整 / 连接缺失返回错误说明 */
export function resolveVaultSyncTarget(cfg: VaultFileSyncConfig): ResolvedTarget | { error: string } {
  if (cfg.localDir) {
    try {
      return { store: createLocalFsObjectStore(cfg.localDir), target: `local:${cfg.localDir}` }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }
  if (!cfg.locationId) return { error: '未选择存储连接（或本地目录）' }
  const loc = getStorageLocation(cfg.locationId)
  if (!loc) return { error: `存储连接 ${cfg.locationId} 不存在` }
  if (loc.kind === 's3' && loc.s3) {
    const s3 = loc.s3
    if (!s3.bucket || !s3.region || !s3.accessKeyId || !s3.secretAccessKey) return { error: 'S3 连接不完整' }
    return {
      store: createS3ObjectStore({
        bucket: s3.bucket,
        region: s3.region,
        endpoint: s3.endpoint,
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
        forcePathStyle: s3.forcePathStyle,
      }),
      target: `s3://${s3.bucket}/${cfg.prefix}`,
    }
  }
  if (loc.kind === 'webdav' && loc.webdav) {
    if (!loc.webdav.endpoint) return { error: 'WebDAV 连接不完整' }
    return {
      store: createWebDavObjectStore(loc.webdav),
      target: `webdav:${loc.webdav.endpoint}/${cfg.prefix}`,
    }
  }
  return { error: `不支持的连接类型：${loc.kind}` }
}

export function createVaultFileSync(ctx: VaultContext): VaultFileSync {
  let running = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  let nextRunAt: string | null = null
  let lastPushAt: string | null = null
  let lastPullAt: string | null = null
  let lastError: string | null = null
  let lastPush: VaultPushResult | null = null
  let lastPull: VaultPullResult | null = null
  let inFlight: Promise<unknown> | null = null

  const deps = (cfg: VaultFileSyncConfig, resolved: ResolvedTarget) => ({
    store: resolved.store,
    prefix: cfg.prefix,
    root: ctx.config.root,
    ignore: ctx.config.ignore,
    deviceId: getDeviceId(),
    db: ctx.db,
  })

  /** 确保远端 meta 存在并回写本端 vault_id（首次同步时生成） */
  const ensureIdentity = async (cfg: VaultFileSyncConfig, store: ObjectStore): Promise<string> => {
    const meta = await ensureVaultSyncMeta(store, cfg.prefix, cfg.vaultId)
    if (meta.vault_id !== cfg.vaultId) setVaultSyncVaultId(meta.vault_id)
    return meta.vault_id
  }

  const runPush = async (): Promise<VaultPushResult> => {
    const cfg = getVaultFileSyncConfig()
    const resolved = resolveVaultSyncTarget(cfg)
    if ('error' in resolved) throw new Error(resolved.error)
    await ensureIdentity(cfg, resolved.store)
    const result = await ctx.lock(() => pushVaultFiles(deps(cfg, resolved)))
    lastPush = result
    lastPushAt = new Date().toISOString()
    lastError = null
    return result
  }

  const runPull = async (): Promise<VaultPullResult> => {
    const cfg = getVaultFileSyncConfig()
    const resolved = resolveVaultSyncTarget(cfg)
    if ('error' in resolved) throw new Error(resolved.error)
    await ensureIdentity(cfg, resolved.store)
    const result = await ctx.lock(() => pullVaultFiles(deps(cfg, resolved)))
    lastPull = result
    lastPullAt = new Date().toISOString()
    lastError = null
    // 落盘后让索引追平（watcher 正常时几乎全是 stat 跳过）
    if (result.applied > 0 || result.deleted > 0) {
      const { reconcileVault } = await import('./ingest')
      await ctx.lock(() => reconcileVault(ctx, { light: true }))
    }
    return result
  }

  const scheduleTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    nextRunAt = null
    const cfg = getVaultFileSyncConfig()
    if (!running || !cfg.enabled || cfg.intervalSeconds <= 0) return
    const ms = Math.max(5_000, cfg.intervalSeconds * 1000)
    nextRunAt = new Date(Date.now() + ms).toISOString()
    timer = setTimeout(() => {
      timer = null
      nextRunAt = null
      void (async () => {
        try {
          await runPull()
          await runPush()
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e)
        } finally {
          scheduleTimer()
        }
      })()
    }, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  const notifyFileChange = (): void => {
    const cfg = getVaultFileSyncConfig()
    if (!running || !cfg.enabled) return
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = null
      void runPush().catch((e) => {
        lastError = e instanceof Error ? e.message : String(e)
      })
    }, PUSH_DEBOUNCE_MS)
    ;(pushTimer as unknown as { unref?: () => void }).unref?.()
  }

  /** 串行化：同时只允许一个 push / pull 在跑（内部还有 ctx.lock 兜底） */
  const serialize = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (inFlight) {
      try {
        await inFlight
      } catch {
        /* 上一轮失败不阻塞下一轮 */
      }
    }
    const p = fn()
    inFlight = p
    try {
      return await p
    } finally {
      if (inFlight === p) inFlight = null
    }
  }

  const push = (): Promise<VaultPushResult> => serialize(runPush)
  const pull = (): Promise<VaultPullResult> => serialize(runPull)

  return {
    start() {
      if (running) return
      running = true
      scheduleTimer()
    },
    stop() {
      running = false
      if (timer) clearTimeout(timer)
      timer = null
      if (pushTimer) clearTimeout(pushTimer)
      pushTimer = null
      nextRunAt = null
    },
    push,
    pull,
    notifyFileChange,
    applyConfig(input) {
      applyVaultFileSyncConfig(input)
      scheduleTimer()
      return this.status()
    },
    status() {
      const cfg = getVaultFileSyncConfig()
      const resolved = resolveVaultSyncTarget(cfg)
      return {
        enabled: cfg.enabled,
        configured: !('error' in resolved),
        target: 'error' in resolved ? null : resolved.target,
        prefix: cfg.prefix,
        interval_seconds: cfg.intervalSeconds,
        vault_id: cfg.vaultId,
        device_id: getDeviceId(),
        last_push_at: lastPushAt,
        last_pull_at: lastPullAt,
        last_error: lastError ?? ('error' in resolved ? resolved.error : null),
        last_push: lastPush,
        last_pull: lastPull,
        tracked_files: listVaultSyncState(ctx.db).length,
        next_run_at: nextRunAt,
        running,
      }
    },
  }
}

/** 供状态展示：本端可同步文件数（只 stat） */
export async function countSyncableFiles(ctx: VaultContext): Promise<number> {
  return (await listSyncableFiles(ctx.config.root, ctx.config.ignore)).length
}
