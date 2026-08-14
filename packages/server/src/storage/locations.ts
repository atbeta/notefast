/**
 * 存储连接库持久化（data/storage-locations.json）
 *
 * 备份 / 多端同步 / Markdown 归档共用：bucket/凭据/endpoint 填一次，
 * 各能力引用 connectionId + 自己的前缀。密钥脱敏沿用旧值（mergeStorageLocation）。
 */

import {
  mergeStorageLocation,
  publicStorageLocation,
  type StorageLocation,
  type StorageLocationInput,
} from '@notefast/core'
import { createJsonConfigStore } from '../services/jsonConfig'

const CONFIG_FILE = 'storage-locations.json'

const store = createJsonConfigStore<StorageLocation[]>({
  fileName: CONFIG_FILE,
  empty: () => [],
  parse: (raw) => {
    const arr = raw as StorageLocation[]
    return Array.isArray(arr) ? arr.filter((l) => l?.id && l?.kind) : null
  },
})

let locations: StorageLocation[] = []

export function initStorageLocations(dir: string): void {
  locations = store.init(dir)
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

function saveToDisk(): void {
  store.set(locations)
}

/** 测试钩子 */
export function _resetStorageLocationsForTests(): void {
  store._resetForTests()
  locations = []
}
