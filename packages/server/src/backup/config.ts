/**
 * 备份配置持久化（data/backup.config.json）
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  emptyBackupConfig,
  mergeBackupConfig,
  publicBackupView,
  type BackupConfigInput,
  type BackupPersistedConfig,
} from '@notefast/core'

const CONFIG_FILE = 'backup.config.json'

let dataDir = ''
let cfg: BackupPersistedConfig = emptyBackupConfig()

export function initBackupConfig(dir: string): BackupPersistedConfig {
  dataDir = dir
  cfg = loadFromDisk()
  return cfg
}

export function getBackupConfig(): BackupPersistedConfig {
  return cfg
}

export function getBackupPublicConfig(): BackupPersistedConfig {
  return publicBackupView(cfg)
}

export function applyBackupConfig(incoming: BackupConfigInput): BackupPersistedConfig {
  cfg = mergeBackupConfig(incoming, cfg)
  saveToDisk(cfg)
  return cfg
}

export function disableBackupConfig(): BackupPersistedConfig {
  cfg = emptyBackupConfig()
  saveToDisk(cfg)
  return cfg
}

export function loadFromDisk(): BackupPersistedConfig {
  if (!dataDir) return emptyBackupConfig()
  const path = join(dataDir, CONFIG_FILE)
  if (!existsSync(path)) return emptyBackupConfig()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as BackupPersistedConfig
    if (raw && raw.version === 1) return raw
  } catch {
    /* ignore */
  }
  return emptyBackupConfig()
}

export function saveToDisk(c: BackupPersistedConfig): void {
  if (!dataDir) throw new Error('backup dataDir 未初始化')
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
export function _resetBackupConfigForTests(): void {
  dataDir = ''
  cfg = emptyBackupConfig()
}
