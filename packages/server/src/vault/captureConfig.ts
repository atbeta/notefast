/**
 * 采集默认落盘目录（data/vault-capture.json，RFC 0005 U-11）
 *
 * 只解决一件事：新采集的收集箱文件默认写到哪里，免得根目录被采集件堆满。
 *
 * **这是「默认落点」，不是「状态 ↔ 目录绑定」**：
 * - 权威永远是 frontmatter 里的 `notefast_status`；用户把文件从 `Inbox/` 搬到 `notes/`，
 *   它仍然是收集箱；手工往 `Inbox/` 放一个文件，它也不会变成收集箱
 * - 应用只决定**自己新建文件**的位置，绝不移动用户已有的文件
 * - 留空 = 落 vault 根目录（默认，行为与以前一致）
 */

import { createJsonConfigStore } from '../services/jsonConfig'
import { toVaultRelPath } from './paths'

export interface VaultCaptureConfig {
  version: 1
  /** 相对 vault 根的目录；null/空 = 根目录 */
  dir: string | null
}

export function emptyVaultCaptureConfig(): VaultCaptureConfig {
  return { version: 1, dir: null }
}

const store = createJsonConfigStore<VaultCaptureConfig>({
  fileName: 'vault-capture.json',
  empty: emptyVaultCaptureConfig,
  parse: (raw) => {
    const c = raw as VaultCaptureConfig
    if (!c || c.version !== 1) return null
    return { version: 1, dir: typeof c.dir === 'string' && c.dir.trim() ? c.dir.trim() : null }
  },
})

export function initVaultCaptureConfig(dir: string): VaultCaptureConfig {
  return store.init(dir)
}

export function getVaultCaptureConfig(): VaultCaptureConfig {
  return store.get()
}

/**
 * 采集默认目录（相对 vault 根）；未配置 / 非法时返回 null（落根目录）。
 * 校验口径与写回一致：越界路径一律当没配。
 */
export function getVaultCaptureDir(vaultRoot: string | null): string | null {
  const dir = store.get().dir
  if (!dir || !vaultRoot) return null
  try {
    return toVaultRelPath(vaultRoot, dir)
  } catch {
    return null
  }
}

/**
 * 保存采集目录。`dir` 为空 → 落根目录；非法（越界 / 绝对路径）→ 抛错，由路由映射成 400。
 */
export function applyVaultCaptureConfig(vaultRoot: string, dir: string | null): VaultCaptureConfig {
  const raw = (dir ?? '').trim()
  if (!raw) {
    store.set(emptyVaultCaptureConfig())
    return store.get()
  }
  const rel = toVaultRelPath(vaultRoot, raw)
  if (!rel) throw new Error('目录不能是 vault 根')
  store.set({ version: 1, dir: rel })
  return store.get()
}

/** 测试钩子 */
export function _resetVaultCaptureConfigForTests(): void {
  store._resetForTests()
}
