/**
 * vault 文件监听（chokidar v4）+ 串行事件队列
 *
 * - awaitWriteFinish 合并编辑器一次保存产生的多次 fs 事件
 * - 同一路径的连续事件在队列里合并（只保留最后一个）
 * - 串行处理：SQLite 单写者，避免两次 ingest 同一文档交错
 * - unlink 先挂起 renameGraceMs：窗口内出现同 sha 的 add 即视为 rename（纯移动，引用/向量不丢）
 * - 单文件失败只记日志，不影响其他文件
 */

import chokidar, { type FSWatcher } from 'chokidar'
import type { Stats } from 'node:fs'
import { getVaultFileByPath } from '../store/vaultFiles'
import { ingestVaultFile, moveVaultFilePath, removeVaultFile, type IngestResult, type VaultContext } from './ingest'
import { isIgnoredRelPath, isMarkdownPath, toVaultAbsPath, toVaultRelPath, VaultPathError } from './paths'
import { readVaultFile } from './writer'

export interface VaultWatcherOptions {
  /** unlink 等待配对 add 的窗口；默认 max(1000, stabilityMs * 3) */
  renameGraceMs?: number
  onResult?: (result: IngestResult) => void
  onError?: (relPath: string, error: unknown) => void
}

export interface VaultWatcher {
  close: () => Promise<void>
  /** 等待队列与挂起的 unlink 全部处理完（测试 / 优雅停机用） */
  idle: () => Promise<void>
  /** 直接投递事件（测试用，绕过 fs） */
  push: (kind: 'change' | 'unlink', relPath: string) => void
}

type Job = { kind: 'change' | 'unlink' | 'unlink-flush'; relPath: string }

export function createVaultQueue(ctx: VaultContext, opts: VaultWatcherOptions = {}): VaultWatcher & { enqueue: (job: Job) => void } {
  const graceMs = opts.renameGraceMs ?? Math.max(1000, ctx.config.stabilityMs * 3)
  const queue: Job[] = []
  const heldUnlinks = new Map<string, { sha: string; timer: ReturnType<typeof setTimeout> }>()
  let running = false
  const idleWaiters: Array<() => void> = []

  const report = (r: IngestResult) => opts.onResult?.(r)
  const fail = (rel: string, e: unknown) => {
    if (opts.onError) opts.onError(rel, e)
    else console.warn(`[vault] ${rel}:`, e instanceof Error ? e.message : e)
  }

  const settleIdle = () => {
    if (running || queue.length > 0 || heldUnlinks.size > 0) return
    while (idleWaiters.length > 0) idleWaiters.shift()!()
  }

  const enqueue = (job: Job) => {
    // 同路径合并：后来的事件覆盖先前的（unlink-flush 例外，它由定时器投递，不参与合并）
    if (job.kind !== 'unlink-flush') {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i]!.relPath === job.relPath && queue[i]!.kind !== 'unlink-flush') queue.splice(i, 1)
      }
    }
    queue.push(job)
    if (!running) {
      running = true
      void drain()
    }
  }

  const holdUnlink = (relPath: string) => {
    const row = getVaultFileByPath(ctx.db, ctx.notebookId, relPath)
    if (!row || row.deleted_at) return
    const prev = heldUnlinks.get(relPath)
    if (prev) clearTimeout(prev.timer)
    const timer = setTimeout(() => enqueue({ kind: 'unlink-flush', relPath }), graceMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    heldUnlinks.set(relPath, { sha: row.content_sha256, timer })
  }

  const tryPairRename = async (toRel: string): Promise<boolean> => {
    if (heldUnlinks.size === 0) return false
    const file = await readVaultFile(toVaultAbsPath(ctx.config.root, toRel))
    if (!file) return false
    for (const [fromRel, held] of heldUnlinks) {
      if (held.sha !== file.sha256) continue
      clearTimeout(held.timer)
      heldUnlinks.delete(fromRel)
      report(moveVaultFilePath(ctx, fromRel, toRel))
      return true
    }
    return false
  }

  const runJob = async (job: Job) => {
    switch (job.kind) {
      case 'change': {
        if (await tryPairRename(job.relPath)) return
        report(await ingestVaultFile(ctx, job.relPath))
        return
      }
      case 'unlink': {
        holdUnlink(job.relPath)
        return
      }
      case 'unlink-flush': {
        const held = heldUnlinks.get(job.relPath)
        if (!held) return
        heldUnlinks.delete(job.relPath)
        // 文件可能在窗口内又回来了（编辑器「删除后重建」保存策略）
        const back = await readVaultFile(toVaultAbsPath(ctx.config.root, job.relPath))
        report(back ? await ingestVaultFile(ctx, job.relPath) : removeVaultFile(ctx, job.relPath))
        return
      }
    }
  }

  const drain = async () => {
    while (queue.length > 0) {
      const job = queue.shift()!
      try {
        await ctx.lock(() => runJob(job))
      } catch (e) {
        fail(job.relPath, e)
      }
    }
    running = false
    settleIdle()
  }

  const toRel = (absPath: string): string | null => {
    try {
      const rel = toVaultRelPath(ctx.config.root, absPath)
      if (!isMarkdownPath(rel) || isIgnoredRelPath(rel, ctx.config.ignore)) return null
      return rel
    } catch (e) {
      if (e instanceof VaultPathError) return null
      throw e
    }
  }

  return {
    enqueue,
    push: (kind, relPath) => {
      const rel = toRel(toVaultAbsPath(ctx.config.root, relPath))
      if (rel) enqueue({ kind, relPath: rel })
    },
    idle: () =>
      new Promise<void>((resolve) => {
        if (!running && queue.length === 0 && heldUnlinks.size === 0) return resolve()
        // 挂起的 unlink 由定时器投递 unlink-flush，drain 结束后统一唤醒
        idleWaiters.push(resolve)
      }),
    close: async () => {
      for (const held of heldUnlinks.values()) clearTimeout(held.timer)
      heldUnlinks.clear()
    },
  }
}

export async function startVaultWatcher(ctx: VaultContext, opts: VaultWatcherOptions = {}): Promise<VaultWatcher> {
  const q = createVaultQueue(ctx, opts)
  const root = ctx.config.root

  const ignored = (absPath: string, stats?: Stats): boolean => {
    let rel: string
    try {
      rel = toVaultRelPath(root, absPath)
    } catch {
      return absPath !== root
    }
    if (isIgnoredRelPath(rel, ctx.config.ignore)) return true
    if (stats?.isFile() && !isMarkdownPath(rel)) return true
    return false
  }

  const watcher: FSWatcher = chokidar.watch(root, {
    ignored,
    persistent: true,
    ignoreInitial: true, // 存量由 reconcileVault 处理
    awaitWriteFinish: { stabilityThreshold: ctx.config.stabilityMs, pollInterval: Math.min(100, Math.max(20, ctx.config.stabilityMs / 3)) },
    // 原生事件在 bind mount / 网络盘 / macOS 符号链接路径（/tmp → /private/tmp）下不可靠，按配置退回轮询
    usePolling: ctx.config.usePolling,
    interval: ctx.config.pollIntervalMs,
    binaryInterval: ctx.config.pollIntervalMs,
  })

  watcher.on('add', (p: string) => q.push('change', p))
  watcher.on('change', (p: string) => q.push('change', p))
  watcher.on('unlink', (p: string) => q.push('unlink', p))
  watcher.on('error', (e: unknown) => opts.onError?.('', e))

  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()))

  return {
    push: q.push,
    idle: q.idle,
    close: async () => {
      await watcher.close()
      await q.close()
    },
  }
}
