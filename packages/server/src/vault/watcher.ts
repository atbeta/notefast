/**
 * vault 文件监听器（chokidar 封装）
 *
 * @see docs/rfcs/0001-vault-mode.md §"增量索引流程"
 *
 * 设计要点：
 *   - 用 awaitWriteFinish 防止编辑器保存时的多次 fs event 风暴
 *   - 串行处理事件队列，避免 SQLite 写锁竞争
 *   - 错误隔离：单个文件失败不影响其他文件
 */

import chokidar, { type FSWatcher } from 'chokidar'
import type { VaultConfig } from './config'

export interface VaultWatcher {
  close: () => Promise<void>
  watched: number
}

export interface WatcherCallbacks {
  onChange: (filePath: string) => Promise<void> | void
  onDelete: (filePath: string) => Promise<void> | void
}

export async function startVaultWatcher(
  config: VaultConfig,
  callbacks: WatcherCallbacks,
): Promise<VaultWatcher> {
  const glob = `${config.path}/**/*.md`

  const watcher = chokidar.watch(glob, {
    ignored: (path: string) => {
      const rel = path.slice(config.path.length + 1)
      return config.ignore.some((pattern) => rel.startsWith(pattern))
    },
    persistent: true,
    ignoreInitial: true, // 启动时不触发；用 rebuildVaultIndex 处理存量
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  })

  // 串行队列：避免并发 ingest
  const queue: Array<() => Promise<void>> = []
  let running = false

  const enqueue = (job: () => Promise<void>) => {
    queue.push(job)
    if (!running) {
      running = true
      void drain()
    }
  }

  const drain = async () => {
    while (queue.length > 0) {
      const job = queue.shift()!
      try {
        await job()
      } catch (err) {
        console.error('[vault watcher] job failed:', err)
      }
    }
    running = false
  }

  watcher.on('add', (filePath: string) =>
    enqueue(() => Promise.resolve(callbacks.onChange(filePath))),
  )
  watcher.on('change', (filePath: string) =>
    enqueue(() => Promise.resolve(callbacks.onChange(filePath))),
  )
  watcher.on('unlink', (filePath: string) =>
    enqueue(() => Promise.resolve(callbacks.onDelete(filePath))),
  )

  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()))

  return {
    close: () => watcher.close(),
    watched: watcher.getWatched ? Object.keys(watcher.getWatched()).length : 0,
  }
}

export async function stopVaultWatcher(w: VaultWatcher): Promise<void> {
  await w.close()
}
