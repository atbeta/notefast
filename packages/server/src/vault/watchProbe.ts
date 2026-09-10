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
import { readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VaultConfig } from './config'

export type WatchBackend = 'native' | 'polling'

export interface WatchMode {
  /** 实际生效：true = 轮询，false = 原生事件 */
  usePolling: boolean
  /** true = 由文件系统判定 / 探测得出（env 未显式指定） */
  auto: boolean
  /** 结论来源，便于日志排障 */
  reason: 'env' | 'watch-off' | 'filesystem' | 'path' | 'probe' | 'pending'
}

/**
 * 虚拟 / 网络文件系统：容器里的 bind mount（Docker Desktop、OrbStack 的 virtiofs、9p）
 * 与 NAS 挂载（nfs / cifs / smb）都不保证投递**宿主侧**改动。
 *
 * 实测（OrbStack + virtiofs）：容器内写文件会触发事件，但宿主机新建的文件迟迟不进索引。
 * 单文件探测只写自己这一侧，测不出这个方向，所以先看文件系统类型再决定要不要探测。
 */
const UNRELIABLE_FS = /^(fuse|virtiofs|9p|nfs|cifs|smb|sshfs|davfs|afs|glusterfs|ceph)/i

export function isUnreliableFilesystem(fsType: string | null | undefined): boolean {
  return typeof fsType === 'string' && UNRELIABLE_FS.test(fsType)
}

/**
 * macOS 的临时区域经符号链接（`/tmp` → `/private/tmp`、`/var/folders` → `/private/var/folders`），
 * FSEvents 在那里投递极不稳定：V-501 基准实测 1000 文件中位 3776ms、样本到 14s
 * （同一环境轮询中位 323ms）。单文件探测 12ms 就拿到事件，**测不出这个方向**，
 * 所以按路径结构直接判为不可靠。
 */
export function isUnreliableDarwinPath(root: string): boolean {
  if (process.platform !== 'darwin') return false
  try {
    const real = realpathSync.native(root)
    const withSlash = real.endsWith('/') ? real : `${real}/`
    return withSlash.startsWith('/private/tmp/') || withSlash.startsWith('/private/var/folders/')
  } catch {
    return false
  }
}

/** 读 `/proc/self/mounts`，取包含该路径的最长挂载点的文件系统类型（仅 Linux；其他平台 null） */
export function detectFilesystemType(path: string): string | null {
  if (process.platform !== 'linux') return null
  try {
    const mounts = readFileSync('/proc/self/mounts', 'utf8').split('\n')
    let best: { mountPoint: string; fsType: string } | null = null
    for (const line of mounts) {
      const parts = line.split(' ')
      const mountPoint = parts[1]
      const fsType = parts[2]
      if (!mountPoint || !fsType) continue
      const mp = mountPoint.replace(/\\040/g, ' ')
      const inMount = path === mp || path.startsWith(mp.endsWith('/') ? mp : `${mp}/`)
      if (!inMount) continue
      if (!best || mp.length > best.mountPoint.length) best = { mountPoint: mp, fsType }
    }
    return best?.fsType ?? null
  } catch {
    return null
  }
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
  /** 结论已出：禁止再补写探测文件（否则清理后又被定时器重建，留下残留） */
  let finished = false
  const touchTimers: Array<ReturnType<typeof setTimeout>> = []
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
      let settled = false
      const hit = () => {
        if (settled) return
        settled = true
        resolve(true)
      }
      watcher!.on('add', hit)
      watcher!.on('change', hit)
      watcher!.on('unlink', hit)
      watcher!.once('error', () => {
        if (settled) return
        settled = true
        resolve(false)
      })
      watcher!.once('ready', () => {
        // ready 之后再改文件，确保事件是「新发生」的；首次写入可能与 chokidar
        // 初始扫描的窗口重叠而被吞掉，所以中途再补一次（探测失败只会退化成轮询，方向安全）
        const touch = () => {
          if (settled || finished) return
          try {
            writeFileSync(probePath, `probe-${Date.now()}`)
          } catch {
            /* 写入失败：交给超时兜底 */
          }
        }
        touchTimers.push(
          setTimeout(touch, 60),
          setTimeout(touch, Math.max(250, Math.floor(timeoutMs / 2))),
          setTimeout(touch, Math.max(400, Math.floor((timeoutMs * 3) / 4))),
        )
      })
    })

    const timedOut = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })

    return (await Promise.race([gotEvent, timedOut])) ? 'native' : 'polling'
  } catch {
    return 'polling'
  } finally {
    finished = true
    for (const t of touchTimers) clearTimeout(t)
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
  fsTypeOf: (root: string) => string | null = detectFilesystemType,
  unreliablePathOf: (root: string) => boolean = isUnreliableDarwinPath,
): Promise<WatchMode> {
  if (!config.watch) return { usePolling: config.usePolling, auto: false, reason: 'watch-off' }
  if (config.pollingSource === 'env') {
    return { usePolling: config.usePolling, auto: false, reason: 'env' }
  }
  // bind mount / 网络盘：宿主侧改动不一定投递，直接轮询（不必花 1.5s 探测）
  const fsType = fsTypeOf(config.root)
  if (isUnreliableFilesystem(fsType)) {
    console.warn(
      `[notefast] vault 位于 ${fsType} 文件系统（bind mount / 网络盘），` +
        '原生事件不保证投递宿主侧改动，使用轮询',
    )
    return { usePolling: true, auto: true, reason: 'filesystem' }
  }
  // macOS 临时区域（符号链接到 /private/…）：原生事件延迟可达十几秒
  if (unreliablePathOf(config.root)) {
    console.warn(
      '[notefast] vault 位于 macOS 临时区域（/tmp、/var/folders 经符号链接），' +
        '原生事件投递不稳定，使用轮询',
    )
    return { usePolling: true, auto: true, reason: 'path' }
  }
  const backend = await probe(config.root)
  return { usePolling: backend === 'polling', auto: true, reason: 'probe' }
}
