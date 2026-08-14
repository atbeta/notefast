/**
 * 备份配置持久化（data/backup.config.json）
 */

import {
  emptyBackupConfig,
  mergeBackupConfig,
  publicBackupView,
  type BackupConfigInput,
  type BackupPersistedConfig,
} from '@notefast/core'
import { createJsonConfigStore } from '../services/jsonConfig'

const store = createJsonConfigStore<BackupPersistedConfig>({
  fileName: 'backup.config.json',
  empty: emptyBackupConfig,
  parse: (raw) => {
    const c = raw as BackupPersistedConfig
    return c && c.version === 1 ? c : null
  },
})

export function initBackupConfig(dir: string): BackupPersistedConfig {
  return store.init(dir)
}

export function getBackupConfig(): BackupPersistedConfig {
  return store.get()
}

export function getBackupPublicConfig(): BackupPersistedConfig {
  return publicBackupView(store.get())
}

export function applyBackupConfig(incoming: BackupConfigInput): BackupPersistedConfig {
  store.set(mergeBackupConfig(incoming, store.get()))
  return store.get()
}

export function disableBackupConfig(): BackupPersistedConfig {
  store.set(emptyBackupConfig())
  return store.get()
}

/** 测试钩子 */
export function _resetBackupConfigForTests(): void {
  store._resetForTests()
}
