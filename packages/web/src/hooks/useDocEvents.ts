/**
 * 应用变更订阅（SSE /api/v1/events）
 *
 * 模块级单例连接：所有订阅者共享一条 SSE 流，断线指数退避重连（1s→30s）。
 * 用 fetch 流式读取而非 EventSource —— 后者无法携带 Authorization 头。
 * 服务端已在 300ms 窗口内按 docId 聚合文档事件；固定视图为即时帧。
 * 订阅方收到事件直接 refetch 即可。
 */

import { useEffect, useRef } from 'react'
import { fetchWithAuth } from './useAPI'

export interface DocChangeEvent {
  doc_id: string
  kind: 'created' | 'updated' | 'deleted'
  at: string
}

type DocListener = (ev: DocChangeEvent) => void
type PinnedListener = () => void

const docListeners = new Set<DocListener>()
const pinnedListeners = new Set<PinnedListener>()
let running = false
let retryDelay = 1000
/** 当前连接/退避等待的取消句柄：最后一个订阅者退订时主动断开回收 */
let currentAbort: AbortController | null = null
const RETRY_MAX_MS = 30_000
/** 连接看门狗：服务端心跳 25s，超过 30s 无任何帧判定连接僵死——
 *  macOS 睡眠/网络切换后 TCP 半开连接既不报错也不结束，fetch 会永远挂起，
 *  表象就是「左侧列表不再自动更新，手动导航后才刷新」。
 *  另配 visibilitychange 主动重连（睡眠恢复/切回标签立即重连，不等看门狗） */
const WATCHDOG_MS = 30_000

function subscriberCount(): number {
  return docListeners.size + pinnedListeners.size
}

function startIfNeeded(): void {
  if (!running) {
    void loop()
    window.addEventListener('visibilitychange', onVisibilityChange)
  }
}

function stopIfIdle(): void {
  if (subscriberCount() === 0) {
    currentAbort?.abort()
    window.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

/** 页面从后台回到前台时主动重连：睡眠/切标签后 TCP 半开连接最可能发生，
 *  不等看门狗（30s）立即踢断当前连接，让 loop 马上重建 SSE */
function kickStaleConnection(): void {
  if (!running || !currentAbort) return
  // 重置退避到初始值：用户切回前台说明网络可能已恢复，直接以最快节奏重连
  retryDelay = 1000
  currentAbort.abort()
}

/** 订阅 doc 级变更；返回取消订阅函数。首个订阅者触发连接，全部退订即主动断开回收 */
export function subscribeDocChanges(fn: DocListener): () => void {
  docListeners.add(fn)
  startIfNeeded()
  return () => {
    docListeners.delete(fn)
    stopIfIdle()
  }
}

/** 订阅侧栏固定视图变更（MCP / 其它标签页 pin）；与 doc 共用同一条 SSE */
export function subscribePinnedViewsChanges(fn: PinnedListener): () => void {
  pinnedListeners.add(fn)
  startIfNeeded()
  return () => {
    pinnedListeners.delete(fn)
    stopIfIdle()
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') kickStaleConnection()
}

async function loop(): Promise<void> {
  running = true
  while (subscriberCount() > 0) {
    const ac = new AbortController()
    currentAbort = ac
    try {
      const res = await fetchWithAuth('/events', { signal: ac.signal })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      retryDelay = 1000 // 连接成功即重置退避
      await readStream(res.body)
    } catch {
      // 断线 / 服务重启 / 401（未登录）/ 全部退订主动 abort：退避后重连（无订阅者则退出）
    }
    if (subscriberCount() === 0) break
    // 退避等待同样可被 abort 打断，避免退订后 running 残留到退避结束才复位
    await new Promise((r) => {
      const t = setTimeout(r, retryDelay)
      ac.signal.addEventListener('abort', () => { clearTimeout(t); r(undefined) }, { once: true })
    })
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
  }
  currentAbort = null
  running = false
}

async function readStream(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let watchdog = setTimeout(() => reader.cancel().catch(() => {}), WATCHDOG_MS)
  const kick = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => reader.cancel().catch(() => {}), WATCHDOG_MS)
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      kick()
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        let eventName = 'message'
        let data = ''
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (!data) continue
        try {
          if (eventName === 'doc') {
            const ev = JSON.parse(data) as DocChangeEvent
            for (const fn of docListeners) fn(ev)
          } else if (eventName === 'pinned_views') {
            for (const fn of pinnedListeners) fn()
          }
        } catch {
          // 单帧解析失败跳过（心跳/ping 帧已被 event 名过滤）
        }
      }
    }
  } finally {
    clearTimeout(watchdog)
    reader.cancel().catch(() => {})
  }
}

/** React 绑定：挂载期间订阅 doc 变更（回调经 ref 取最新，不触发重订阅） */
export function useDocChanges(fn: DocListener): void {
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => subscribeDocChanges((ev) => fnRef.current(ev)), [])
}
