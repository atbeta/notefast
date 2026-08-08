/**
 * 服务可达性探测
 *
 * 周期 ping /api/v1/auth/mode（免鉴权端点，最适合做健康检查），连
 * 续 N 次失败 → "offline"。用于在 Tauri 壳（本机 server 可能挂）或
 * LAN 部署（网络抖动）场景下，给用户一个总览信号，而不是让每一个
 * fetch 都以 toast 失败呈现。
 *
 * 设计：
 *  - 单例 + useSyncExternalStore：多个组件订阅同一探测，timer 只跑一份
 *  - 首个订阅者挂载时启动探测，最后一个卸载时停；可见性切换到 hidden
 *    暂停（节流），回到 visible 立即重跑一次
 *  - 默认 probe /api/v1/auth/mode（公开端点，server 死亡 vs auth 未配
 *    能区分开；GET /api/v1/status 也行但要带鉴权）
 *  - 网络错误归类：fetch 抛 TypeError / AbortError / timeout → 失败计数
 *    HTTP 200 但 body 解析失败 / 5xx / 401 也算失败（server 能响应但
 *    状态不对——recover 后会再切 online）
 *
 * 返回 ServerHealthSnapshot（含最近一次错误与探测时间），让 UI 既能
 * 反映状态，又能在 offline 时给用户一点上下文（"上次错误：连接被拒绝"）。
 */

import { useSyncExternalStore } from 'react'

export type ServerHealth = 'unknown' | 'online' | 'offline'

export interface ServerHealthSnapshot {
  status: ServerHealth
  lastError: string | null
  lastCheckedAt: number
}

const PROBE_URL = '/api/v1/auth/mode'
const PROBE_INTERVAL_MS = 8_000
const PROBE_TIMEOUT_MS = 4_000
const FAIL_THRESHOLD = 3

let snapshot: ServerHealthSnapshot = {
  status: 'unknown',
  lastError: null,
  lastCheckedAt: 0,
}
let consecutiveFailures = 0
let mounted = 0
let probeTimer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((l) => l())
}

async function probe(): Promise<void> {
  if (typeof document !== 'undefined' && document.hidden) return
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const r = await fetch(PROBE_URL, {
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    })
    clearTimeout(timeoutId)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    await r.text().catch(() => undefined)
    consecutiveFailures = 0
    if (snapshot.status !== 'online' || snapshot.lastError !== null) {
      snapshot = { status: 'online', lastError: null, lastCheckedAt: Date.now() }
      emit()
    } else {
      snapshot = { status: 'online', lastError: null, lastCheckedAt: Date.now() }
    }
  } catch (err) {
    clearTimeout(timeoutId)
    consecutiveFailures++
    const message = err instanceof Error ? err.message : String(err)
    if (consecutiveFailures >= FAIL_THRESHOLD && snapshot.status !== 'offline') {
      snapshot = { status: 'offline', lastError: message, lastCheckedAt: Date.now() }
      emit()
    } else {
      snapshot = { status: snapshot.status, lastError: message, lastCheckedAt: Date.now() }
      emit()
    }
  }
}

function ensureProbing(): void {
  if (probeTimer != null) return
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  probeTimer = setInterval(() => void probe(), PROBE_INTERVAL_MS)
  void probe()
}

function stopProbing(): void {
  if (probeTimer != null) {
    clearInterval(probeTimer)
    probeTimer = null
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

function onVisibilityChange(): void {
  if (typeof document === 'undefined') return
  if (document.visibilityState === 'visible' && mounted > 0) {
    void probe()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  mounted++
  if (mounted === 1) ensureProbing()
  return () => {
    listeners.delete(listener)
    mounted--
    if (mounted === 0) stopProbing()
  }
}

function getSnapshot(): ServerHealthSnapshot {
  return snapshot
}

function getServerSnapshot(): ServerHealthSnapshot {
  return { status: 'unknown', lastError: null, lastCheckedAt: 0 }
}

/** 在任意组件内订阅服务可达性 */
export function useServerHealth(): ServerHealthSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** 同步读当前快照（不订阅，用于一次性检查） */
export function getServerHealthNow(): ServerHealthSnapshot {
  return snapshot
}

/** 强制立即跑一次探测（例如用户点了"重试"按钮） */
export function forceHealthProbe(): void {
  if (mounted > 0) void probe()
}