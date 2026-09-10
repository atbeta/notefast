/**
 * watcher 后端探测（RFC 0005 U-2）
 *
 * 确定性用例覆盖「探测失败 → 轮询」与「显式 env 优先」；
 * 真实文件系统只断言「不崩、不留探测文件、结论稳定」，不假设平台一定投递原生事件。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  detectFilesystemType,
  isUnreliableDarwinPath,
  isUnreliableFilesystem,
  probeNativeWatch,
  resolveWatchMode,
  WATCH_PROBE_PREFIX,
} from '../vault/watchProbe'
import { loadVaultConfigFromEnv } from '../vault/config'

/** 探测要在真实目录上跑：优先 $HOME（macOS 的 /tmp 经符号链接，FSEvents 不投递） */
function makeProbeDir(): string {
  const base = (() => {
    try {
      const d = mkdtempSync(join(homedir(), '.notefast-probe-test-'))
      return d
    } catch {
      return mkdtempSync(join('/tmp', 'notefast-probe-test-'))
    }
  })()
  return base
}

let dir: string
beforeAll(() => {
  dir = makeProbeDir()
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveWatchMode', () => {
  const base = { root: '/tmp/vault', watch: true, usePolling: false, pollingSource: 'auto' as const }

  test('watch 关闭：不探测，沿用配置值', async () => {
    let called = false
    const mode = await resolveWatchMode(
      { ...base, watch: false },
      async () => {
        called = true
        return 'native'
      },
    )
    expect(called).toBe(false)
    expect(mode).toMatchObject({ usePolling: false, auto: false })
  })

  test('env 显式指定：不探测，尊重用户选择（false 也保留）', async () => {
    let called = false
    const mode = await resolveWatchMode(
      { ...base, pollingSource: 'env', usePolling: false },
      async () => {
        called = true
        return 'polling'
      },
    )
    expect(called).toBe(false)
    expect(mode).toMatchObject({ usePolling: false, auto: false })
  })

  test('自动：原生事件可用 → 不轮询', async () => {
    const mode = await resolveWatchMode(base, async () => 'native')
    expect(mode).toMatchObject({ usePolling: false, auto: true })
  })

  test('自动：原生事件不可用 → 退回轮询', async () => {
    const mode = await resolveWatchMode(base, async () => 'polling')
    expect(mode).toMatchObject({ usePolling: true, auto: true, reason: 'probe' })
  })

  test('bind mount / 网络盘：直接轮询，不做探测', async () => {
    let probed = false
    const mode = await resolveWatchMode(
      base,
      async () => {
        probed = true
        return 'native'
      },
      () => 'virtiofs',
    )
    expect(probed).toBe(false)
    expect(mode).toEqual({ usePolling: true, auto: true, reason: 'filesystem' })
  })

  test('本地文件系统：仍然按探测结果决定', async () => {
    const mode = await resolveWatchMode(base, async () => 'native', () => 'ext4')
    expect(mode).toEqual({ usePolling: false, auto: true, reason: 'probe' })
  })

  test('macOS 临时区域路径：直接轮询，不做探测', async () => {
    let probed = false
    const mode = await resolveWatchMode(
      base,
      async () => {
        probed = true
        return 'native'
      },
      () => 'apfs',
      () => true,
    )
    expect(probed).toBe(false)
    expect(mode).toEqual({ usePolling: true, auto: true, reason: 'path' })
  })

  test('env 显式指定：优先级高于文件系统判定', async () => {
    const mode = await resolveWatchMode(
      { ...base, pollingSource: 'env', usePolling: false },
      async () => 'polling',
      () => 'virtiofs',
    )
    expect(mode).toEqual({ usePolling: false, auto: false, reason: 'env' })
  })
})

describe('文件系统判定', () => {
  test('虚拟 / 网络文件系统一律视为不可靠', () => {
    for (const t of ['fuse', 'fuse.grpcfuse', 'virtiofs', '9p', 'nfs4', 'cifs', 'smb3', 'sshfs']) {
      expect(isUnreliableFilesystem(t)).toBe(true)
    }
    for (const t of ['ext4', 'xfs', 'btrfs', 'apfs', 'overlay', null, undefined]) {
      expect(isUnreliableFilesystem(t)).toBe(false)
    }
  })

  test('macOS 临时区域判定：/tmp 与 /var/folders 为真，普通路径为假', () => {
    if (process.platform !== 'darwin') {
      expect(isUnreliableDarwinPath('/tmp/x')).toBe(false)
      return
    }
    expect(isUnreliableDarwinPath('/tmp')).toBe(true)
    expect(isUnreliableDarwinPath(dir)).toBe(true) // 测试目录建在 $HOME 或 /tmp，后者经 /private
    expect(isUnreliableDarwinPath('/Users')).toBe(false)
  })

  test('detectFilesystemType：非 Linux 返回 null，Linux 至少不抛', () => {
    const t = detectFilesystemType(dir)
    if (process.platform !== 'linux') expect(t).toBeNull()
    else expect(typeof t === 'string' || t === null).toBe(true)
  })
})

describe('probeNativeWatch', () => {
  test('超时即判定为轮询（不静默漏事件）', async () => {
    expect(await probeNativeWatch(dir, 0)).toBe('polling')
  })

  test('目录不存在 / 不可写：返回轮询而不抛异常', async () => {
    expect(await probeNativeWatch(join(dir, 'missing', 'nested'), 50)).toBe('polling')
  })

  test('真实目录：返回合法后端，且不留探测文件', async () => {
    // 结论本身依赖环境（macOS 的 /tmp 经符号链接、CI 容器等），只断言合法性与无残留；
    // 「探测失败必须退化成轮询」由上面的超时用例确定性地覆盖。
    const first = await probeNativeWatch(dir, 800)
    expect(['native', 'polling']).toContain(first)
    const second = await probeNativeWatch(dir, 800)
    expect(['native', 'polling']).toContain(second)
    const leftovers = readdirSync(dir).filter((n) => n.startsWith(WATCH_PROBE_PREFIX))
    expect(leftovers).toEqual([])
  })
})

describe('配置：pollingSource', () => {
  test('未设 VAULT_USE_POLLING → auto；显式 true/false → env', () => {
    const auto = loadVaultConfigFromEnv({ VAULT_PATH: dir })!
    expect(auto.pollingSource).toBe('auto')
    expect(auto.usePolling).toBe(false)

    const on = loadVaultConfigFromEnv({ VAULT_PATH: dir, VAULT_USE_POLLING: 'true' })!
    expect(on.pollingSource).toBe('env')
    expect(on.usePolling).toBe(true)

    const off = loadVaultConfigFromEnv({ VAULT_PATH: dir, VAULT_USE_POLLING: 'false' })!
    expect(off.pollingSource).toBe('env')
    expect(off.usePolling).toBe(false)

    // 拼错的值不当作显式指定：交给探测
    const typo = loadVaultConfigFromEnv({ VAULT_PATH: dir, VAULT_USE_POLLING: 'yes' })!
    expect(typo.pollingSource).toBe('auto')
  })
})
