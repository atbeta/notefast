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
  /** 图片理解（chat 已配置且设置开启）：聊天图片输入 / 索引 caption 的显示依据 */
  vision: boolean
}

/** 含探测完成标志，便于空态区分「还在探测」与「确认未配置」 */
export type AiCapabilitiesSnapshot = AiCapabilities & { ready: boolean }

const EMPTY: AiCapabilities = { chat: false, embedding: false, reranker: false, vision: false }
const SERVER_SNAPSHOT: AiCapabilitiesSnapshot = { ...EMPTY, ready: false }

let snapshot: AiCapabilities = EMPTY
let loaded = false
/** 缓存给 useSyncExternalStore 的不可变快照；仅在数据变化时换新引用 */
let clientSnapshot: AiCapabilitiesSnapshot = SERVER_SNAPSHOT
let mounted = 0
const listeners = new Set<() => void>()

function rebuildClientSnapshot(): void {
  const next: AiCapabilitiesSnapshot = { ...snapshot, ready: loaded }
  // 快照未变化时保持原引用：useSyncExternalStore 用 Object.is 比较，
  // 无谓的新引用会让订阅组件每次 fetch 都重渲染（输入时闪烁的来源之一）
  if (
    clientSnapshot.chat !== next.chat
    || clientSnapshot.embedding !== next.embedding
    || clientSnapshot.reranker !== next.reranker
    || clientSnapshot.vision !== next.vision
    || clientSnapshot.ready !== next.ready
  ) {
    clientSnapshot = next
  }
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
      vision: !!cap.vision,
    }
    loaded = true
  } catch {
    // 探测失败：保留上次成功的 snapshot，不重置为 EMPTY。
    // 否则已配置状态会因一次网络抖动闪成「未配置」（chat=false → 面板显示
    // notConfigured），下次探测成功又恢复——远程部署下表现为输入时闪烁。
    // 首次探测（从未成功过）才按未配置处理。
    if (!loaded) {
      snapshot = EMPTY
      loaded = true
    }
  }
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

/**
 * 同步读当前 capabilities 快照（不订阅）。
 * 供高频挂载的组件（如 BlockHandle 每块一个）用——避免几百个订阅者在
 * snapshot 引用变化时同时重渲染。这些组件只需在用户交互（打开菜单）
 * 时读最新值，不需要实时响应配置变化。
 */
export function getAiCapabilitiesSnapshot(): AiCapabilitiesSnapshot {
  return clientSnapshot
}

/** 强制重探测（例如用户在 settings 改完配置返回） */
export function refreshAiCapabilities(): void {
  loaded = false
  snapshot = EMPTY
  rebuildClientSnapshot()
  emit()
  void fetchCapabilities()
}

/**
 * 静默重探测：不重置 loaded（ready 保持 true），后台 fetch 新值。
 * 打开 AI 面板时用这个——避免「已配置」瞬间闪成「未配置」（重置 loaded 会让
 * ready=false → 上游按未配置渲染），新值到了再平滑更新。
 */
export function refreshAiCapabilitiesSilent(): void {
  void fetchCapabilities()
}
