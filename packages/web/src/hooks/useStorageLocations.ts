import { useState, useEffect, useCallback } from 'react'
import { api } from './useAPI'
import type { StorageLocation } from '@notefast/core'

/**
 * 存储连接库（GET /storage-locations）共享 hook。
 * 备份 / 多端同步 / Markdown 归档 三处共用，避免重复实现。
 */
export function useStorageLocations(): {
  locations: StorageLocation[]
  refresh: () => Promise<void>
} {
  const [locations, setLocations] = useState<StorageLocation[]>([])

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ locations: StorageLocation[] }>('/storage-locations')
      setLocations(res.locations ?? [])
    } catch {
      setLocations([])
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return { locations, refresh }
}
