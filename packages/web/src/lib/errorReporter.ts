/**
 * 客户端错误埋点集中上报
 *
 * 三个来源统一进队：
 *  - ErrorBoundary.componentDidCatch → reportBoundaryError(err, stack)
 *  - window 'error' 事件（render 之外的同步 throw、资源加载失败）
 *  - window 'unhandledrejection'（Promise 漏 catch）
 *
 * 设计取舍：
 *  - sendBeacon 优先（page hide 也能送达），失败回退到 fetch keepalive
 *  - 60 秒去重窗口（同一 hash 在窗口内只报一次，噪声控制）
 *  - 5 秒 / 20 条 flush 节流，pagehide 强制 flush
 *  - 永远不抛错——埋点本身就是观测，不该再引入崩溃
 *
 * 注意：appVersion 暂为字面量，等 vite define / build 注入接进来再换。
 */

import { getStoredToken } from '../hooks/useAPI'

const ENDPOINT = '/api/v1/client-errors'
const APP_VERSION = 'web-0.51.0'
const QUEUE_FLUSH_MS = 5_000
const MAX_BATCH = 20
const DEDUP_WINDOW_MS = 60_000

type Source = 'boundary' | 'window' | 'unhandledrejection'

interface Report {
  source: Source
  message: string
  stack?: string
  componentStack?: string
  hash: string
  url?: string
  appVersion?: string
  userAgent?: string
  extra?: Record<string, unknown>
}

const seen = new Map<string, number>()
let queue: Report[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let installed = false

/** 选前一条非空 stack 行 + message 前 100 字做去重 key（同源同位置合并） */
function hashFor(source: Source, message: string, stack?: string): string {
  const firstStackLine = (stack ?? '').split('\n').find((l) => l.trim()) ?? ''
  return `${source}::${firstStackLine}::${message.slice(0, 100)}`.slice(0, 64)
}

function shouldReport(hash: string): boolean {
  const last = seen.get(hash) ?? 0
  const now = Date.now()
  if (now - last < DEDUP_WINDOW_MS) return false
  seen.set(hash, now)
  return true
}

function buildReport(source: Source, error: unknown, componentStack?: string): Report {
  const err =
    error instanceof Error
      ? error
      : typeof error === 'string'
        ? new Error(error)
        : (() => {
            const e = new Error('Unknown error')
            ;(e as Error & { detail?: unknown }).detail = error
            return e
          })()
  return {
    source,
    message: (err.message || String(err)).slice(0, 500),
    stack: err.stack?.slice(0, 8192),
    componentStack: componentStack?.slice(0, 8192),
    hash: hashFor(source, err.message, err.stack),
    url: typeof window !== 'undefined' ? window.location.href : undefined,
    appVersion: APP_VERSION,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  }
}

async function send(reports: Report[]): Promise<void> {
  if (reports.length === 0) return
  try {
    const body = JSON.stringify({ errors: reports })
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' })
      const ok = navigator.sendBeacon(ENDPOINT, blob)
      if (ok) return
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = getStoredToken()
    if (token) headers.Authorization = `Bearer ${token}`
    await fetch(ENDPOINT, { method: 'POST', headers, body, keepalive: true })
  } catch {
    // 埋点自身永不抛错
  }
}

function enqueue(report: Report): void {
  if (!shouldReport(report.hash)) return
  queue.push(report)
  if (queue.length >= MAX_BATCH) {
    flush()
    return
  }
  if (flushTimer == null) {
    flushTimer = setTimeout(flush, QUEUE_FLUSH_MS)
  }
}

function flush(): void {
  if (flushTimer != null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const batch = queue.splice(0, queue.length)
  if (batch.length > 0) void send(batch)
}

/** 在 main.tsx 启动时调一次；重复调幂等 */
export function install(): void {
  if (installed) return
  installed = true
  if (typeof window === 'undefined') return

  window.addEventListener('error', (e) => {
    enqueue(buildReport('window', e.error ?? e.message, undefined))
  })

  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason
    enqueue(buildReport('unhandledrejection', reason))
  })

  // 页面即将卸载时强制 flush 一次（避免 setTimeout 没机会跑）
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
}

/** ErrorBoundary.componentDidCatch 直接调用 */
export function reportBoundaryError(error: Error, componentStack?: string): void {
  enqueue(buildReport('boundary', error, componentStack))
}