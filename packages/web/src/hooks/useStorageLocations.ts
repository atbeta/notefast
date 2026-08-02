import { useState, useEffect } from 'react'
import { api } from './useAPI'
import type { StorageLocation } from '@notefast/core'

/**
 * 存储连接库（GET /storage-locations）共享 hook。
 *
 * 模块级缓存 + 订阅：创建/更新/删除连接后调用 `refreshStorageLocations()`，
 * 所有使用方（备份 / 多端同步 / 归档面板的连接下拉）即时刷新，无需整页重载。
 */

let locationsCache: StorageLocation[] | null = null
let inFlight: Promise<StorageLocation[]> | null = null
const listeners = new Set<() => void>()

async function fetchLocations(): Promise<StorageLocation[]> {
  try {
    const res = await api.get<{ locations: StorageLocation[] }>('/storage-locations')
    return res.locations ?? []
  } catch {
    return []
  }
}

/** 刷新共享缓存并通知所有订阅方 */
export async function refreshStorageLocations(): Promise<void> {
  if (inFlight) {
    locationsCache = await inFlight
    inFlight = null
  } else {
    locationsCache = await fetchLocations()
  }
  listeners.forEach((fn) => fn())
}

export function useStorageLocations(): {
  locations: StorageLocation[]
  refresh: () => Promise<void>
} {
  const [locations, setLocations] = useState<StorageLocation[]>(locationsCache ?? [])

  useEffect(() => {
    const update = () => setLocations(locationsCache ?? [])
    listeners.add(update)
    if (locationsCache === null && !inFlight) {
      inFlight = fetchLocations().then((locs) => {
        locationsCache = locs
        inFlight = null
        listeners.forEach((fn) => fn())
        return locs
      })
    }
    return () => {
      listeners.delete(update)
    }
  }, [])

  return { locations, refresh: refreshStorageLocations }
}
