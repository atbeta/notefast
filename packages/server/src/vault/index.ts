/**
 * vault mode 运行时（RFC 0001）：把默认 notebook 绑定到一个文件夹，文件是权威、SQLite 是派生索引。
 *
 * 生命周期：
 *   start()  绑定 notebook（kind='vault'）→ 先挂 watcher（不漏事件）→ 后台全量对账 → 可选写回
 *   stop()   停 watcher / 写回
 *
 * 路由：/api/v1/vault/{status,files,rebuild,ingest}
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { getDb } from '../db'
import {
  bindNotebookToVault,
  deleteVaultFileRow,
  getNotebookVaultBinding,
  getVaultFileByDocId,
  listVaultFiles,
} from '../store/vaultFiles'
import { listVaultWritebackConflicts } from '../services/appLogs'
import type { VaultConfig } from './config'
import { createSerialLock } from './lock'
import { ingestVaultFile, reconcileVault, type IngestResult, type ReconcileStats, type VaultContext } from './ingest'
import { isIgnoredRelPath, toVaultAbsPath, VaultPathError, toVaultRelPath } from './paths'
import { startVaultWatcher, type VaultWatcher } from './watcher'
import { resolveWatchMode, type WatchMode } from './watchProbe'
import { buildVaultTree } from './tree'
import { listUnresolvedTargets } from '../store/vaultLinks'
import { listVaultConflicts, listVaultTrash } from './inspect'
import { createVaultFileSync, type VaultFileSync, type VaultFileSyncStatus } from './fileSyncRuntime'
import { getVaultFileSyncConfig } from './fileSyncConfig'
import { vaultFileSyncConfigSchema } from '@notefast/core'
import { startVaultWriteback, type VaultWriteback } from './writeback'
import { sha256Hex } from './writer'

export type { VaultConfig } from './config'
export { loadVaultConfigFromEnv } from './config'

type Db = ReturnType<typeof getDb>

/**
 * 当前进程的 vault runtime（未启用 vault 时为 null）。
 * MCP 工具在 app.ts 注册之后才被调用，且启动顺序保证 runtime 先就位，
 * 因此这里用模块级引用而不是改 registerMcpTools 的签名。
 */
let activeRuntime: VaultRuntime | null = null

export function getActiveVaultRuntime(): VaultRuntime | null {
  return activeRuntime
}

export function setActiveVaultRuntime(runtime: VaultRuntime | null): void {
  activeRuntime = runtime
}

export interface VaultStatus {
  enabled: true
  root: string
  notebook_id: string
  watch: boolean
  writeback: boolean
  use_polling: boolean
  /** true = 轮询是启动探测的结果（VAULT_USE_POLLING 未显式指定，RFC 0005 U-2） */
  polling_auto: boolean
  /** 实际生效的 watcher 后端 */
  watcher_mode: 'native' | 'polling' | 'off'
  watcher_active: boolean
  reconciling: boolean
  files: number
  last_reconcile: ReconcileStats | null
  /** 最近 24h 写回冲突：计数 + 最近 10 条冲突副本路径（RFC 0003 阶段 D） */
  conflicts: { count: number; paths: string[] }
  /** 下一次定时轻量对账时间（ISO）；未开启定时对账时为 null */
  next_reconcile_at: string | null
  /** 文件同步（RFC 0004）状态 */
  sync: VaultFileSyncStatus
}

export interface VaultRuntime {
  readonly ctx: VaultContext
  start(opts?: { awaitReconcile?: boolean }): Promise<void>
  stop(): Promise<void>
  status(): VaultStatus
  rebuild(): Promise<ReconcileStats>
  ingest(path: string): Promise<IngestResult>
  /** 等待 watcher 队列 / 写回队列 / 后台对账全部空闲（测试与优雅停机） */
  idle(): Promise<void>
  /** 文件同步（RFC 0004）；未配置时各方法返回错误说明，不抛异常 */
  sync: VaultFileSync
  /** 永久删除文档后清理 vault 侧残留（`.trash/` 副本 + 映射行，RFC 0005 U-9） */
  discardTrashed(docId: string): void
}

export function createVaultRuntime(opts: { db: Db; notebookId: string; config: VaultConfig }): VaultRuntime {
  const ctx: VaultContext = { db: opts.db, notebookId: opts.notebookId, config: opts.config, lock: createSerialLock() }
  let watcher: VaultWatcher | null = null
  let writeback: VaultWriteback | null = null
  let reconciling: Promise<ReconcileStats> | null = null
  let lastReconcile: ReconcileStats | null = null
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null
  let nextReconcileAt: string | null = null
  /** watcher 后端：env 显式指定，或启动时探测得出（RFC 0005 U-2） */
  let watchMode: WatchMode = { usePolling: opts.config.usePolling, auto: false, reason: 'pending' }
  const fileSync = createVaultFileSync(ctx)

  const runReconcile = (light: boolean): Promise<ReconcileStats> => {
    if (reconciling) return reconciling
    reconciling = ctx.lock(() => reconcileVault(ctx, { light }))
      .then((stats) => {
        lastReconcile = stats
        return stats
      })
      .finally(() => {
        reconciling = null
      })
    return reconciling
  }

  const rebuild = (): Promise<ReconcileStats> => runReconcile(false)

  /**
   * 定时轻量对账（V-404）：chokidar 漏事件 / 休眠唤醒后的自愈兜底。
   * 与手动 rebuild 共用 reconciling 状态与串行锁，所以面板能显示、也不会交错。
   */
  const scheduleReconcile = (): void => {
    if (ctx.config.reconcileMinutes <= 0) return
    const ms = Math.max(1000, Math.round(ctx.config.reconcileMinutes * 60_000))
    nextReconcileAt = new Date(Date.now() + ms).toISOString()
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null
      nextReconcileAt = null
      const run = reconciling ?? runReconcile(true)
      run
        .catch((e) => console.warn('[vault] 定时对账失败:', e instanceof Error ? e.message : e))
        .finally(() => scheduleReconcile())
    }, ms)
    // CLI / 测试场景：定时器不阻止进程退出
    ;(reconcileTimer as unknown as { unref?: () => void }).unref?.()
  }

  const stopReconcileTimer = (): void => {
    if (reconcileTimer) clearTimeout(reconcileTimer)
    reconcileTimer = null
    nextReconcileAt = null
  }

  /**
   * 永久删除（清空回收站）后的 vault 侧清理：
   * 索引行随 blocks 一起消失，但 `.trash/` 里的副本与 `vault_files` 映射行会残留，
   * 这里把两者一并清掉。命中不到文件（被外部挪走 / 重名加了时间戳）不算错。
   */
  const discardTrashed = (docId: string): void => {
    const row = getVaultFileByDocId(ctx.db, docId)
    if (!row) return
    const parts = row.rel_path.split('/')
    const trashDir = join(ctx.config.root, '.trash', ...parts.slice(0, -1))
    const base = parts[parts.length - 1] ?? row.rel_path
    const candidates = [join(trashDir, base)]
    // 写回冲突时重名会加 `.时间戳` 后缀（writeback.ts），按前缀兜底捞一份
    const stem = base.replace(/\.md$/i, '')
    try {
      for (const name of readdirSync(trashDir)) {
        if (name.startsWith(`${stem}.`) && name.toLowerCase().endsWith('.md')) {
          candidates.push(join(trashDir, name))
        }
      }
    } catch {
      /* 目录不存在：只试精确路径 */
    }
    for (const abs of candidates) {
      try {
        if (existsSync(abs)) unlinkSync(abs)
      } catch {
        /* 删不掉：巡检页仍能看到残留，不阻断永久删除 */
      }
    }
    deleteVaultFileRow(ctx.db, ctx.notebookId, row.rel_path)
  }

  const runtime: VaultRuntime = {
    ctx,
    async start(startOpts = {}) {
      const binding = getNotebookVaultBinding(ctx.db, ctx.notebookId)
      if (!binding) throw new Error(`notebook 不存在: ${ctx.notebookId}`)
      if (binding.kind === 'vault' && binding.vault_root && binding.vault_root !== ctx.config.root) {
        throw new Error(
          `notebook 已绑定到另一个 vault（${binding.vault_root}），拒绝切换到 ${ctx.config.root}；` +
            '换 vault 请使用新的 DATA_DIR',
        )
      }
      if (binding.kind !== 'vault' || binding.vault_root !== ctx.config.root) {
        bindNotebookToVault(ctx.db, ctx.notebookId, ctx.config.root)
      }
      setActiveVaultRuntime(runtime)

      if (ctx.config.watch && !watcher) {
        // 先实测 vault 根是否投递原生事件，再决定后端（Docker bind mount / macOS 符号链接路径会失败）
        watchMode = await resolveWatchMode(ctx.config)
        watcher = await startVaultWatcher(ctx, {
          usePolling: watchMode.usePolling,
          onError: (rel, e) => console.warn(`[vault] watcher ${rel}:`, e instanceof Error ? e.message : e),
          // 文件变了 → 去抖推送到远端（RFC 0004）
          onResult: () => fileSync.notifyFileChange(),
        })
      }
      if (ctx.config.writeback && !writeback) {
        writeback = startVaultWriteback(ctx, {
          onOutcome: (docId, outcome) => {
            if (outcome.kind === 'conflict') {
              console.warn(`[vault] 写回冲突，已保留磁盘版本: ${outcome.relPath} (doc ${docId})`)
            } else if (outcome.kind === 'written') {
              // 写回落了盘 → 也要推到远端
              fileSync.notifyFileChange()
            }
          },
        })
      }

      fileSync.start()
      // 启动时先 pull（拿到别端改动）再对账；同步失败不阻断启动
      const syncCfg = getVaultFileSyncConfig()
      if (syncCfg.enabled) {
        try {
          await fileSync.pull()
        } catch (e) {
          console.warn('[vault] 启动文件同步失败:', e instanceof Error ? e.message : e)
        }
      }

      scheduleReconcile()

      const job = rebuild().then((stats) => {
        console.log(
          `📂 vault 对账完成: ${stats.totalFiles} 文件，+${stats.created} ~${stats.updated} =${stats.unchanged}` +
            ` ↺${stats.restored} →${stats.moved} -${stats.deleted}，${stats.durationMs}ms` +
            (stats.errors.length ? `，${stats.errors.length} 个错误` : ''),
        )
        return stats
      })
      if (startOpts.awaitReconcile) await job
      else job.catch((e) => console.warn('[vault] 对账失败:', e instanceof Error ? e.message : e))
    },
    async stop() {
      if (watcher) {
        await watcher.close()
        watcher = null
      }
      if (writeback) {
        writeback.stop()
        writeback = null
      }
      stopReconcileTimer()
      fileSync.stop()
      if (activeRuntime === runtime) setActiveVaultRuntime(null)
    },
    status() {
      return {
        enabled: true,
        root: ctx.config.root,
        notebook_id: ctx.notebookId,
        watch: ctx.config.watch,
        writeback: ctx.config.writeback,
        use_polling: watchMode.usePolling,
        polling_auto: watchMode.auto,
        watcher_mode: !ctx.config.watch ? 'off' : watchMode.usePolling ? 'polling' : 'native',
        watcher_active: watcher !== null,
        reconciling: reconciling !== null,
        files: listVaultFiles(ctx.db, ctx.notebookId).length,
        last_reconcile: lastReconcile,
        conflicts: listVaultWritebackConflicts(),
        next_reconcile_at: nextReconcileAt,
        sync: fileSync.status(),
      }
    },
    rebuild,
    sync: fileSync,
    discardTrashed,
    ingest: (path) => ctx.lock(() => ingestVaultFile(ctx, path)),
    async idle() {
      if (reconciling) await reconciling.catch(() => undefined)
      if (watcher) await watcher.idle()
      if (writeback) await writeback.idle()
    },
  }
  return runtime
}

/** 可直出的资源类型白名单（正文 .md 不走这里） */
const VAULT_ASSET_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

export function vaultAssetMime(relPath: string): string | null {
  const ext = relPath.split('.').pop()?.toLowerCase() ?? ''
  return VAULT_ASSET_MIME[ext] ?? null
}

/**
 * `![[x.png]]` 只有文件名：全 vault 找唯一同名资源。
 * 同名多个 → null（多义不猜，让用户写相对路径）。
 */
async function findVaultAssetByBasename(config: VaultConfig, basename: string): Promise<string | null> {
  const target = basename.toLowerCase()
  const matches: string[] = []
  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (depth > 8 || matches.length > 1) return
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (matches.length > 1) return
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (isIgnoredRelPath(rel, config.ignore)) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(join(absDir, entry.name), rel, depth + 1)
      } else if (entry.isFile() && entry.name.toLowerCase() === target) {
        matches.push(rel)
      }
    }
  }
  await walk(config.root, '', 0)
  return matches.length === 1 ? matches[0]! : null
}

/** /api/v1/vault 路由；runtime 为 null 时只回 enabled:false */
export function createVaultRouter(getRuntime: () => VaultRuntime | null): Hono {  const router = new Hono()

  router.get('/status', (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ enabled: false })
    return c.json(rt.status())
  })

  router.get('/files', (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ error: 'vault_disabled', message: '未启用 vault mode' }, 404)
    const includeDeleted = c.req.query('include_deleted') === '1'
    const rows = listVaultFiles(rt.ctx.db, rt.ctx.notebookId, { includeDeleted })
    return c.json(
      rows.map((r) => ({
        rel_path: r.rel_path,
        doc_id: r.doc_id,
        content_sha256: r.content_sha256,
        size: r.size,
        mtime_ms: r.mtime_ms,
        ingested_at: r.ingested_at,
        deleted_at: r.deleted_at,
      })),
    )
  })

  /**
   * 目录树（一层）：`?path=notes/books` 拉该目录的直接子目录与 .md。
   * 前端点开目录再拉下一层——`/files` 是全量行，10k 文件不能一次给前端建树。
   */
  router.get('/tree', (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ error: 'vault_disabled', message: '未启用 vault mode' }, 404)
    const entries = listVaultFiles(rt.ctx.db, rt.ctx.notebookId).map((row) => ({
      relPath: row.rel_path,
      docId: row.doc_id,
    }))
    return c.json(buildVaultTree(entries, { path: c.req.query('path') ?? '', ignore: rt.ctx.config.ignore }))
  })

  /**
   * 未解析 wikilink（侧栏「未解析链接」）：按目标名聚合，附来源文档。
   * `vault_unresolved_links` 表一直只写不读，这里是第一个读出口。
   */
  router.get('/links/unresolved', (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ error: 'vault_disabled', message: '未启用 vault mode' }, 404)
    return c.json(listUnresolvedTargets(rt.ctx.db, rt.ctx.notebookId))
  })

  /** 冲突副本（写回 / 文件同步产生）：按文件名约定从映射表里捞，不扫盘 */
  router.get('/conflicts', (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ error: 'vault_disabled', message: '未启用 vault mode' }, 404)
    return c.json(listVaultConflicts(rt.ctx.db, rt.ctx.notebookId))
  })

  /** 文件夹回收站（`.trash/`）：vault 模式的删除落到这里，与 db 模式的软删除不同轨 */
  router.get('/trash', async (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ error: 'vault_disabled', message: '未启用 vault mode' }, 404)
    return c.json(await listVaultTrash(rt.ctx.config.root))
  })

  /** 文件同步（RFC 0004）：状态 / 配置 / 手动推拉 */
  router.get('/sync/status', (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ error: 'vault_disabled', message: '未启用 vault mode' }, 404)
    return c.json(rt.sync.status())
  })

  /** 当前同步配置（表单回填用；不含凭据） */
  router.get('/sync/config', (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ error: 'vault_disabled', message: '未启用 vault mode' }, 404)
    return c.json(getVaultFileSyncConfig())
  })

  router.put('/sync/config', zValidator('json', vaultFileSyncConfigSchema), (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ error: 'vault_disabled', message: '未启用 vault mode' }, 404)
    const status = rt.sync.applyConfig(c.req.valid('json'))
    if (!status.configured) {
      return c.json({ error: 'bad_request', message: status.last_error ?? '同步目标不可用', sync: status }, 400)
    }
    return c.json(status)
  })

  router.post('/sync/push', async (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ error: 'vault_disabled', message: '未启用 vault mode' }, 404)
    try {
      return c.json(await rt.sync.push())
    } catch (e) {
      return c.json({ error: 'sync_failed', message: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  router.post('/sync/pull', async (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ error: 'vault_disabled', message: '未启用 vault mode' }, 404)
    try {
      return c.json(await rt.sync.pull())
    } catch (e) {
      return c.json({ error: 'sync_failed', message: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  router.post('/rebuild', async (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ error: 'vault_disabled', message: '未启用 vault mode' }, 404)
    return c.json(await rt.rebuild())
  })

  router.post('/ingest', async (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ error: 'vault_disabled', message: '未启用 vault mode' }, 404)
    const body = (await c.req.json().catch(() => null)) as { path?: unknown } | null
    const path = typeof body?.path === 'string' ? body.path.trim() : ''
    if (!path) return c.json({ error: 'bad_request', message: '需要 path（vault 相对路径）' }, 400)
    try {
      return c.json(await rt.ingest(path))
    } catch (e) {
      if (e instanceof VaultPathError) return c.json({ error: 'bad_request', message: e.message }, 400)
      throw e
    }
  })

  /**
   * vault 内静态资源直出（RFC 0001 D6、计划 V-303）：图片 / PDF 不进 data/media，
   * 按文件在 vault 里的真实位置提供。不服务 `.md`（正文只走文档 API）。
   *
   * `![[x.png]]` 这种只有文件名的引用按 Obsidian 规则回退到「全 vault 唯一 basename」，
   * 多义则 404（不猜）。
   */
  router.get('/raw/*', async (c) => {
    const rt = getRuntime()
    if (!rt) return c.json({ error: 'vault_disabled', message: '未启用 vault mode' }, 404)

    const rawRel = c.req.path.slice(c.req.path.indexOf('/raw/') + '/raw/'.length)
    let relPath: string
    try {
      relPath = toVaultRelPath(rt.ctx.config.root, decodeURIComponent(rawRel))
    } catch {
      return c.json({ error: 'bad_request', message: '路径越界' }, 400)
    }
    const mime = vaultAssetMime(relPath)
    if (!mime) return c.json({ error: 'not_found', message: '不是可直出的资源类型' }, 404)

    let abs = toVaultAbsPath(rt.ctx.config.root, relPath)
    let bytes = await readFile(abs).catch(() => null)
    if (!bytes && !relPath.includes('/')) {
      const found = await findVaultAssetByBasename(rt.ctx.config, relPath)
      if (found) {
        relPath = found
        abs = toVaultAbsPath(rt.ctx.config.root, relPath)
        bytes = await readFile(abs).catch(() => null)
      }
    }
    if (!bytes) return c.json({ error: 'not_found', message: `文件不存在: ${relPath}` }, 404)

    const etag = `"${sha256Hex(bytes)}"`
    const headers = {
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=60',
      ETag: etag,
    }
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers)
    return c.body(bytes, 200, headers)
  })

  return router
}
