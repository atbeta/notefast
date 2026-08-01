import { useState, useEffect, useCallback } from 'react'
import { api } from './useAPI'

/**
 * 同步协议状态（GET /sync/protocol）共享轮询 hook。
 * 文档页 SyncStatus 与侧栏 SidebarSyncStatus 共用，避免重复实现轮询。
 */

export interface SyncStatusData {
  configured: boolean
  enabled: boolean
  running: boolean
  lastSuccessAt?: string
  lastError?: string
  state?: { publishedSeq: number; consumedSeq: number }
}

/** 轮询间隔：捕捉去抖触发的同步中状态与完成/失败 */
const POLL_MS = 5000

export function useSyncStatus(): SyncStatusData | null {
  const [status, setStatus] = useState<SyncStatusData | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<SyncStatusData>('/sync/protocol')
      setStatus(res)
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  return status
}
