/**
 * 多端同步协议配置持久化（data/sync-protocol.config.json）
 *
 * 与「数据库备份」完全解耦：独立的 S3 配置、开关与调度。
 */

import {
  emptySyncProtocolConfig,
  mergeSyncProtocolConfig,
  publicSyncProtocolView,
  type SyncProtocolConfigInput,
  type SyncProtocolPersistedConfig,
} from '@notefast/core'
import { createJsonConfigStore } from '../services/jsonConfig'

const store = createJsonConfigStore<SyncProtocolPersistedConfig>({
  fileName: 'sync-protocol.config.json',
  empty: emptySyncProtocolConfig,
  parse: (raw) => {
    const c = raw as SyncProtocolPersistedConfig
    return c && c.version === 1 ? c : null
  },
})

export function initProtocolConfig(dir: string): SyncProtocolPersistedConfig {
  return store.init(dir)
}

export function getProtocolConfig(): SyncProtocolPersistedConfig {
  return store.get()
}

export function getProtocolPublicConfig(): SyncProtocolPersistedConfig {
  return publicSyncProtocolView(store.get())
}

/** 配置文件是否已存在（区分「首次启动」与「已持久化」） */
export function protocolConfigExists(): boolean {
  return store.exists()
}

export function applyProtocolConfig(incoming: SyncProtocolConfigInput): SyncProtocolPersistedConfig {
  store.set(mergeSyncProtocolConfig(incoming, store.get()))
  return store.get()
}

export function disableProtocolConfig(): SyncProtocolPersistedConfig {
  store.set(emptySyncProtocolConfig())
  return store.get()
}

/** 测试钩子 */
export function _resetProtocolConfigForTests(): void {
  store._resetForTests()
}
