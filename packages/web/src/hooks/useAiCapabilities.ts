/**
 * AI 能力探测 hook（chat / embedding / reranker）
 *
 * 与 useServerHealth 同形：单例 + useSyncExternalStore，多个组件订
 * 阅同一份数据，避免每个组件各自 fetch 一次。
 *
 * 取 /api/v1/ai/capabilities（无 key 版本），结果原样转发：
 *  - { chat, embedding, reranker } 为三个能力开关
 *  - ready：首探完成（失败也算 ready，按全 false 处理）
 *  - 探测失败（网络错 / 401 等）一律视为"全 false"，让上游按"未配置"
 *    处理；具体错误由 useServerHealth 单独接管
 *
 * 注意：getSnapshot 必须返回引用稳定的快照——useSyncExternalStore 用
 * Object.is 比较，每次 new 对象会触发无限重渲染（React #185）。
 */

import { useSyncExternalStore } from 'react'
import { api } from './useAPI'

export interface AiCapabilities {
  chat: boolean
  embedding: boolean
  reranker: boolean
}

/** 含探测完成标志，便于空态区分「还在探测」与「确认未配置」 */
export type AiCapabilitiesSnapshot = AiCapabilities & { ready: boolean }

const EMPTY: AiCapabilities = { chat: false, embedding: false, reranker: false }
const SERVER_SNAPSHOT: AiCapabilitiesSnapshot = { ...EMPTY, ready: false }

let snapshot: AiCapabilities = EMPTY
let loaded = false
/** 缓存给 useSyncExternalStore 的不可变快照；仅在数据变化时换新引用 */
let clientSnapshot: AiCapabilitiesSnapshot = SERVER_SNAPSHOT
let mounted = 0
const listeners = new Set<() => void>()

function rebuildClientSnapshot(): void {
  clientSnapshot = { ...snapshot, ready: loaded }
}

function emit(): void {
  listeners.forEach((l) => l())
}

async function fetchCapabilities(): Promise<void> {
  try {
    const cap = await api.get<AiCapabilities>('/ai/capabilities')
    snapshot = {
      chat: !!cap.chat,
      embedding: !!cap.embedding,
      reranker: !!cap.reranker,
    }
  } catch {
    snapshot = EMPTY
  }
  loaded = true
  rebuildClientSnapshot()
  emit()
}

function ensureFetch(): void {
  if (!loaded && mounted > 0) void fetchCapabilities()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  mounted++
  ensureFetch()
  return () => {
    listeners.delete(listener)
    mounted--
  }
}

function getSnapshot(): AiCapabilitiesSnapshot {
  return clientSnapshot
}

function getServerSnapshot(): AiCapabilitiesSnapshot {
  return SERVER_SNAPSHOT
}

export function useAiCapabilities(): AiCapabilitiesSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** 是否"探测完成且任一能力可用"——给上游做空态/有态分支 */
export function getAiCapabilitiesLoaded(): boolean {
  return loaded
}

/** 强制重探测（例如用户在 settings 改完配置返回） */
export function refreshAiCapabilities(): void {
  loaded = false
  snapshot = EMPTY
  rebuildClientSnapshot()
  emit()
  void fetchCapabilities()
}
