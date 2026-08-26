import { useSyncExternalStore } from 'react'
import i18next from '../i18n'
import { api } from './useAPI'
import { nativeNotify } from '../lib/nativeNotify'

/**
 * 同步协议状态（GET /sync/protocol）单例轮询 hook
 * （与 useAiCapabilities 同模式：模块级 store + useSyncExternalStore）。
 * 全局同步状态图标 GlobalSyncStatus 与设置面板共用，首个订阅者启动轮询、
 * 全部退订停止——避免每个组件各自建 5s 定时器。
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
  state?: { publishedSeq: number; consumed: Record<string, number> }
  pendingChanges?: number
}

/** 轮询间隔：捕捉去抖触发的同步中状态与完成/失败 */
const POLL_MS = 5000

/** 模块级去重锚：上一次已通知的错误文本（非 React state——只为防重复弹通知） */
let lastNotifiedError: string | undefined

let snapshot: SyncStatusData | null = null
let timer: ReturnType<typeof setInterval> | null = null
let subscribers = 0
const listeners = new Set<() => void>()

function emit(next: SyncStatusData | null): void {
  // getSnapshot 引用稳定：值相同则不换引用（useSyncExternalStore 用 Object.is 比较）
  if (next === snapshot) return
  snapshot = next
  listeners.forEach((l) => l())
}

async function refresh(): Promise<void> {
  try {
    const res = await api.get<SyncStatusData>('/sync/protocol')
    emit(res)
    const err = res.lastError
    if (err && err !== lastNotifiedError) {
      lastNotifiedError = err
      nativeNotify(i18next.t('notify.syncFailed'), err)
    } else if (!err) {
      lastNotifiedError = undefined
    }
  } catch {
    emit(null)
  }
}

function ensurePolling(): void {
  if (subscribers > 0 && !timer) {
    timer = setInterval(() => { void refresh() }, POLL_MS)
  }
}

function stopPolling(): void {
  if (subscribers === 0 && timer) {
    clearInterval(timer)
    timer = null
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  subscribers++
  ensurePolling()
  void refresh()
  return () => {
    listeners.delete(listener)
    subscribers--
    stopPolling()
  }
}

function getSnapshot(): SyncStatusData | null {
  return snapshot
}

function getServerSnapshot(): SyncStatusData | null {
  return null
}

export function useSyncStatus(): SyncStatusData | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
