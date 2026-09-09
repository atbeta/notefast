/**
 * 原生文件事件探测（RFC 0005 U-2）
 *
 * 为什么不按平台写死：Linux 宿主上的 bind mount 能投递 inotify，Docker Desktop
 * （macOS / Windows）的 bind mount 不能；macOS 上经符号链接的路径（/tmp → /private/tmp）
 * FSEvents 也不投递。与其让用户背「什么环境要开轮询」，不如启动时对 vault 根实测一次。
 *
 * 探测只写一个隐藏临时文件（任一段以 `.` 开头的路径被 `paths.isIgnoredRelPath` 忽略，
 * 不会被 ingest），跑完即删；`depth: 0` 只监听根目录，避免对大库做全量扫描。
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VaultConfig } from './config'

export type WatchBackend = 'native' | 'polling'

export interface WatchMode {
  /** 实际生效：true = 轮询，false = 原生事件 */
  usePolling: boolean
  /** true = 由探测得出（env 未显式指定） */
  auto: boolean
}

/** 探测文件前缀：隐藏文件，且带独立前缀便于排障时识别 */
export const WATCH_PROBE_PREFIX = '.notefast-watch-probe-'

/**
 * 实测 vault 根是否投递原生事件。
 * 超时 / 出错一律返回 `polling`——宁可多轮询一次，也不要静默漏事件。
 */
export async function probeNativeWatch(root: string, timeoutMs = 1500): Promise<WatchBackend> {
  const probePath = join(root, `${WATCH_PROBE_PREFIX}${process.pid}-${Date.now()}`)
  let watcher: FSWatcher | null = null
  try {
    writeFileSync(probePath, 'probe-init')
    watcher = chokidar.watch(root, {
      depth: 0,
      persistent: false,
      ignoreInitial: true,
      usePolling: false,
      // 只关心探测文件：其余路径全部忽略，避免大库初始扫描
      ignored: (p: string) => p !== root && !p.startsWith(probePath),
    })

    const gotEvent = new Promise<boolean>((resolve) => {
      const hit = () => resolve(true)
      watcher!.on('add', hit)
      watcher!.on('change', hit)
      watcher!.on('unlink', hit)
      watcher!.once('ready', () => {
        // 监听就绪后再改文件，确保事件是「新发生」的
        try {
          writeFileSync(probePath, `probe-${Date.now()}`)
        } catch {
          resolve(false)
        }
      })
      watcher!.once('error', () => resolve(false))
    })

    const timedOut = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })

    return (await Promise.race([gotEvent, timedOut])) ? 'native' : 'polling'
  } catch {
    return 'polling'
  } finally {
    try {
      await watcher?.close()
    } catch {
      /* 关闭失败不影响结论 */
    }
    try {
      unlinkSync(probePath)
    } catch {
      /* 探测文件可能已被外部删除 */
    }
  }
}

/**
 * 决定这次启动用哪种 watcher 后端。
 * `VAULT_USE_POLLING` 显式给出时永远优先；未给（或值无法识别）时探测。
 */
export async function resolveWatchMode(
  config: Pick<VaultConfig, 'root' | 'watch' | 'usePolling' | 'pollingSource'>,
  probe: (root: string, timeoutMs?: number) => Promise<WatchBackend> = probeNativeWatch,
): Promise<WatchMode> {
  if (!config.watch) return { usePolling: config.usePolling, auto: false }
  if (config.pollingSource === 'env') return { usePolling: config.usePolling, auto: false }
  const backend = await probe(config.root)
  return { usePolling: backend === 'polling', auto: true }
}
