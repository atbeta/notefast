/**
 * vault 文件同步配置持久化（data/vault-sync.config.json，RFC 0004）
 *
 * 与 db 模式协议同步（data/sync-protocol.config.json）互不相干：
 * vault 模式下只允许这一套文件同步。
 */

import {
  emptyVaultFileSyncConfig,
  mergeVaultFileSyncConfig,
  publicVaultFileSyncView,
  type VaultFileSyncConfig,
  type VaultFileSyncConfigInput,
} from '@notefast/core'
import { createJsonConfigStore } from '../services/jsonConfig'

const store = createJsonConfigStore<VaultFileSyncConfig>({
  fileName: 'vault-sync.config.json',
  empty: emptyVaultFileSyncConfig,
  parse: (raw) => {
    const c = raw as VaultFileSyncConfig
    return c && c.version === 1 ? c : null
  },
})

export function initVaultFileSyncConfig(dir: string): VaultFileSyncConfig {
  return store.init(dir)
}

export function getVaultFileSyncConfig(): VaultFileSyncConfig {
  return store.get()
}

export function getPublicVaultFileSyncConfig(): VaultFileSyncConfig {
  return publicVaultFileSyncView(store.get())
}

export function applyVaultFileSyncConfig(incoming: VaultFileSyncConfigInput): VaultFileSyncConfig {
  store.set(mergeVaultFileSyncConfig(incoming, store.get()))
  return store.get()
}

/**
 * 写入 vault 身份（引擎首次同步时生成）。
 * 不走 merge：merge 有意保留旧 vaultId，避免用户改配置时把身份改掉。
 */
export function setVaultSyncVaultId(vaultId: string): VaultFileSyncConfig {
  store.set({ ...store.get(), vaultId })
  return store.get()
}

export function disableVaultFileSyncConfig(): VaultFileSyncConfig {
  store.set(emptyVaultFileSyncConfig())
  return store.get()
}

/** 测试钩子 */
export function _resetVaultFileSyncConfigForTests(): void {
  store._resetForTests()
}
