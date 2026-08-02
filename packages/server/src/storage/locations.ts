/**
 * 存储连接库持久化（data/storage-locations.json）
 *
 * 备份 / 多端同步 / Markdown 归档共用：bucket/凭据/endpoint 填一次，
 * 各能力引用 connectionId + 自己的前缀。密钥脱敏沿用旧值（mergeStorageLocation）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  mergeStorageLocation,
  publicStorageLocation,
  type StorageLocation,
  type StorageLocationInput,
} from '@notefast/core'

const CONFIG_FILE = 'storage-locations.json'

let dataDir = ''
let locations: StorageLocation[] = []

export function initStorageLocations(dir: string): void {
  dataDir = dir
  locations = loadFromDisk()
}

export function getStorageLocations(): StorageLocation[] {
  return locations
}

export function getStorageLocation(id: string): StorageLocation | undefined {
  return locations.find((l) => l.id === id)
}

export function getPublicStorageLocations(): StorageLocation[] {
  return locations.map(publicStorageLocation)
}

export function getPublicStorageLocation(id: string): StorageLocation | undefined {
  const l = getStorageLocation(id)
  return l ? publicStorageLocation(l) : undefined
}

/** 新建连接（服务端生成 id） */
export function createStorageLocation(incoming: StorageLocationInput): StorageLocation {
  const loc = mergeStorageLocation({ ...incoming, id: crypto.randomUUID() })
  locations.push(loc)
  saveToDisk()
  return loc
}

/** 更新连接（密钥省略/脱敏时沿用旧值） */
export function updateStorageLocation(id: string, incoming: StorageLocationInput): StorageLocation | null {
  const idx = locations.findIndex((l) => l.id === id)
  if (idx < 0) return null
  const merged = mergeStorageLocation({ ...incoming, id }, locations[idx])
  locations[idx] = merged
  saveToDisk()
  return merged
}

/** 删除连接；被引用的能力将因「连接未找到」降级为未配置 */
export function deleteStorageLocation(id: string): boolean {
  const before = locations.length
  locations = locations.filter((l) => l.id !== id)
  if (locations.length === before) return false
  saveToDisk()
  return true
}

function loadFromDisk(): StorageLocation[] {
  if (!dataDir) return []
  const path = join(dataDir, CONFIG_FILE)
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as StorageLocation[]
    return Array.isArray(raw) ? raw.filter((l) => l?.id && l?.kind) : []
  } catch {
    return []
  }
}

function saveToDisk(): void {
  if (!dataDir) throw new Error('storage locations dataDir 未初始化')
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const path = join(dataDir, CONFIG_FILE)
  writeFileSync(path, JSON.stringify(locations, null, 2) + '\n', 'utf-8')
  try {
    chmodSync(path, 0o600)
  } catch { /* Windows 等环境可能不支持 chmod */ }
}

/** 测试钩子 */
export function _resetStorageLocationsForTests(): void {
  dataDir = ''
  locations = []
}
