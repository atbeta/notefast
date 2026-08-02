/**
 * 多端同步协议配置持久化（data/sync-protocol.config.json）
 *
 * 与「数据库备份」完全解耦：独立的 S3 配置、开关与调度。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  emptySyncProtocolConfig,
  mergeSyncProtocolConfig,
  publicSyncProtocolView,
  type SyncProtocolConfigInput,
  type SyncProtocolPersistedConfig,
} from '@notefast/core'

const CONFIG_FILE = 'sync-protocol.config.json'

let dataDir = ''
let cfg: SyncProtocolPersistedConfig = emptySyncProtocolConfig()
let fileExisted = false

export function initProtocolConfig(dir: string): SyncProtocolPersistedConfig {
  dataDir = dir
  const loaded = loadFromDisk()
  fileExisted = loaded.existed
  cfg = loaded.existed ? loaded.cfg : emptySyncProtocolConfig()
  return cfg
}

export function getProtocolConfig(): SyncProtocolPersistedConfig {
  return cfg
}

export function getProtocolPublicConfig(): SyncProtocolPersistedConfig {
  return publicSyncProtocolView(cfg)
}

/** 配置文件是否已存在（区分「首次启动」与「已持久化」） */
export function protocolConfigExists(): boolean {
  return fileExisted
}

export function applyProtocolConfig(incoming: SyncProtocolConfigInput): SyncProtocolPersistedConfig {
  cfg = mergeSyncProtocolConfig(incoming, cfg)
  saveToDisk(cfg)
  return cfg
}

export function disableProtocolConfig(): SyncProtocolPersistedConfig {
  cfg = emptySyncProtocolConfig()
  saveToDisk(cfg)
  return cfg
}

export function loadFromDisk(): { existed: boolean; cfg: SyncProtocolPersistedConfig } {
  if (!dataDir) return { existed: false, cfg: emptySyncProtocolConfig() }
  const path = join(dataDir, CONFIG_FILE)
  if (!existsSync(path)) return { existed: false, cfg: emptySyncProtocolConfig() }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as SyncProtocolPersistedConfig
    if (raw && raw.version === 1) return { existed: true, cfg: raw }
  } catch {
    /* ignore */
  }
  return { existed: false, cfg: emptySyncProtocolConfig() }
}

export function saveToDisk(c: SyncProtocolPersistedConfig): void {
  if (!dataDir) throw new Error('sync protocol dataDir 未初始化')
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const path = join(dataDir, CONFIG_FILE)
  writeFileSync(path, JSON.stringify(c, null, 2) + '\n', 'utf-8')
  try {
    chmodSync(path, 0o600)
  } catch {
    /* Windows 等环境可能不支持 chmod */
  }
}

/** 测试钩子 */
export function _resetProtocolConfigForTests(): void {
  dataDir = ''
  cfg = emptySyncProtocolConfig()
  fileExisted = false
}
