import { useState, useEffect, useCallback } from 'react'
import i18next from '../i18n'
import { api } from './useAPI'
import { nativeNotify } from '../lib/nativeNotify'

/**
 * 同步协议状态（GET /sync/protocol）共享轮询 hook。
 * 全局同步胶囊 GlobalSyncStatus 与设置面板共用，避免重复实现轮询。
 *
 * 失败转场（无错 → 有错）经 nativeNotify 推一条 macOS 系统通知；
 * 同一错误文本只通知一次（轮询不去重会每 5s 弹一条），恢复清零后再次失败会重新通知。
 */

export interface SyncStatusData {
  configured: boolean
  enabled: boolean
  running: boolean
  lastSuccessAt?: string
  lastError?: string
  state?: { publishedSeq: number; consumedSeq: number }
  pendingChanges?: number
}

/** 轮询间隔：捕捉去抖触发的同步中状态与完成/失败 */
const POLL_MS = 5000

/** 模块级去重锚：上一次已通知的错误文本（非 React state——只为防重复弹通知） */
let lastNotifiedError: string | undefined

export function useSyncStatus(): SyncStatusData | null {
  const [status, setStatus] = useState<SyncStatusData | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<SyncStatusData>('/sync/protocol')
      setStatus(res)
      const err = res.lastError
      if (err && err !== lastNotifiedError) {
        lastNotifiedError = err
        nativeNotify(i18next.t('notify.syncFailed'), err)
      } else if (!err) {
        lastNotifiedError = undefined
      }
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
