/**
 * 投影文件夹监听（chokidar v4）+ 串行事件队列（RFC 0007 D6）。
 *
 * - `awaitWriteFinish` 合并编辑器一次保存产生的多次 fs 事件（否则会读到写了一半的文件）
 * - 同一路径的连续事件在队列里合并（只留最后一个）
 * - 串行处理：SQLite 单写者，避免两次导入同一文档交错
 * - `unlink` 先挂起一个宽限窗口：窗口内文件又出现（编辑器「删除后重建」的保存策略、
 *   同步工具的中间态）就当作没删，避免把文档无谓地丢进回收站
 * - 单文件失败只记日志，不影响其他文件
 *
 * 与 vault watcher 的差别：**没有 rename 配对**。vault 靠 sha 猜「这是不是同一次改名」，
 * 因为路径是它的文件身份；投影下 doc_id 才是身份，配对交给 ingest 的
 * `findMovedProjectionFile`（按内容 + 陈旧路径判定），watcher 只负责投递事件。
 */

import chokidar, { type FSWatcher } from 'chokidar'
import type { Stats } from 'node:fs'
import { getProjectionFileByPath } from '../store/projectionFiles'
import { ingestProjectionFile, removeProjectionFile, type IngestResult, type ProjectionContext } from './ingest'
import { isIgnoredRelPath, isMarkdownPath, ProjectionPathError, toProjectionRelPath } from './paths'
import { readProjectionFile } from './writer'
import { toProjectionAbsPath } from './paths'

/** 绝对路径 → 投影内相对路径；不属于监听范围返回 null */
function toRel(root: string, ignore: readonly string[], absPath: string): string | null {
  try {
    const rel = toProjectionRelPath(root, absPath)
    if (!isMarkdownPath(rel) || isIgnoredRelPath(rel, ignore)) return null
    return rel
  } catch (e) {
    if (e instanceof ProjectionPathError) return null
    throw e
  }
}

export interface ProjectionWatcherOptions {
  /** unlink 宽限窗口：窗口内文件又出现就当没删；默认 max(1000, stabilityMs * 3) */
  unlinkGraceMs?: number
  /** 覆盖 `config.usePolling`（启动探测得出的生效值） */
  usePolling?: boolean
  onResult?: (result: IngestResult) => void
  onError?: (relPath: string, error: unknown) => void
}

export interface ProjectionWatcher {
  close: () => Promise<void>
  /** 等待队列与挂起的 unlink 全部处理完（测试 / 优雅停机用） */
  idle: () => Promise<void>
  /** 直接投递事件（测试用，绕过 fs） */
  push: (kind: 'change' | 'unlink', relPath: string) => void
}

type Job = { kind: 'change' | 'unlink' | 'unlink-flush'; relPath: string }

export function createProjectionQueue(
  ctx: ProjectionContext,
  opts: ProjectionWatcherOptions = {},
): ProjectionWatcher & { enqueue: (job: Job) => void } {
  const graceMs = opts.unlinkGraceMs ?? Math.max(1000, ctx.config.stabilityMs * 3)
  const queue: Job[] = []
  const heldUnlinks = new Map<string, ReturnType<typeof setTimeout>>()
  let running = false
  const idleWaiters: Array<() => void> = []

  const report = (r: IngestResult) => opts.onResult?.(r)
  const fail = (rel: string, e: unknown) => {
    if (opts.onError) opts.onError(rel, e)
    else console.warn(`[projection] ${rel}:`, e instanceof Error ? e.message : e)
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

  /** 只有已经导入过的文件才值得等：没有映射的文件消失不需要处理 */
  const holdUnlink = (relPath: string) => {
    if (!getProjectionFileByPath(ctx.db, ctx.notebookId, relPath)) return
    const prev = heldUnlinks.get(relPath)
    if (prev) clearTimeout(prev)
    const timer = setTimeout(() => enqueue({ kind: 'unlink-flush', relPath }), graceMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    heldUnlinks.set(relPath, timer)
  }

  const runJob = async (job: Job) => {
    switch (job.kind) {
      case 'change':
        report(await ingestProjectionFile(ctx, job.relPath))
        return
      case 'unlink':
        holdUnlink(job.relPath)
        return
      case 'unlink-flush': {
        const timer = heldUnlinks.get(job.relPath)
        if (!timer) return
        heldUnlinks.delete(job.relPath)
        // 文件可能在窗口内又回来了（编辑器「删除后重建」的保存策略）
        const back = await readProjectionFile(toProjectionAbsPath(ctx.config.root, job.relPath))
        report(back ? await ingestProjectionFile(ctx, job.relPath) : removeProjectionFile(ctx, job.relPath))
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

  return {
    enqueue,
    push: (kind, relPath) => enqueue({ kind, relPath }),
    idle: () =>
      new Promise<void>((resolve) => {
        idleWaiters.push(resolve)
        settleIdle()
      }),
    close: async () => {
      for (const timer of heldUnlinks.values()) clearTimeout(timer)
      heldUnlinks.clear()
      queue.length = 0
      settleIdle()
    },
  }
}

/** 起一个真实监听器（chokidar），事件投进串行队列 */
export function startProjectionWatcher(
  ctx: ProjectionContext,
  opts: ProjectionWatcherOptions = {},
): ProjectionWatcher & { ready: () => Promise<void> } {
  const queue = createProjectionQueue(ctx, opts)
  const watcher: FSWatcher = chokidar.watch(ctx.config.root, {
    // 存量由启动时的对账 / 出方向负责，不在这里逐文件触发
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: ctx.config.stabilityMs,
      pollInterval: Math.min(100, Math.max(20, ctx.config.stabilityMs / 3)),
    },
    usePolling: opts.usePolling ?? ctx.config.usePolling,
    interval: ctx.config.pollIntervalMs,
    binaryInterval: ctx.config.pollIntervalMs,
    ignored: (p: string) => {
      // 根目录本身不能忽略
      if (p === ctx.config.root) return false
      const rel = toRel(ctx.config.root, ctx.config.ignore, p)
      return rel === null
    },
  })

  const onFs = (kind: 'change' | 'unlink') => (absPath: string, _stats?: Stats) => {
    const rel = toRel(ctx.config.root, ctx.config.ignore, absPath)
    if (rel === null) return
    queue.enqueue({ kind, relPath: rel })
  }
  watcher.on('add', onFs('change'))
  watcher.on('change', onFs('change'))
  watcher.on('unlink', onFs('unlink'))
  watcher.on('error', (e) => opts.onError?.('', e))

  return {
    push: queue.push,
    idle: async () => {
      await queue.idle()
    },
    ready: () =>
      new Promise<void>((resolve) => {
        watcher.once('ready', () => resolve())
      }),
    close: async () => {
      await queue.close()
      try {
        await watcher.close()
      } catch {
        /* 关闭失败不影响停机 */
      }
    },
  }
}
