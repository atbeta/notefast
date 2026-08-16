/**
 * OS 文件打开预览通道（macOS WKWebView / Tauri WebView2）
 *
 * Shell 把文件内容通过 `notefast:preview` CustomEvent 推给 web：
 *   window.dispatchEvent(new CustomEvent('notefast:preview', {
 *     detail: { title, content, path, contentHash }
 *   }))
 *
 * Web 累积成队列（FIFO），/preview 路由按当前索引展示一项；
 * 上一项 / 下一项 / 关闭一项 / 清空 由调用方决定。
 * 队列持久化到 sessionStorage：壳层 dispatch 事件后整页跳 /preview
 * 会销毁 JS 上下文，纯内存队列会丢（曾导致预览页永远空态）。
 *
 * Shell ↔ web 就绪信号：
 *   监听器挂载时通过既有 `notefast` 通道（macOS webkit messageHandlers
 *   / Tauri invoke）发 { type: 'webReady' }，shell 据此把启动前堆积的
 *   待预览文件 drain 出来（否则冷启动期 dispatch 的事件 web 收不到）。
 *
 * 浏览器形态无来源：isNativeShell() 失败时不挂监听、不发 webReady。
 */

import { useSyncExternalStore } from 'react'
import { isNativeShell } from '../lib/nativeShell'

export interface PreviewItem {
  title: string
  content: string
  path: string
  contentHash: string
}

interface QueueState {
  items: PreviewItem[]
  currentIndex: number
}

const PREVIEW_EVENT = 'notefast:preview'
const MAX_CONTENT_CHARS = 5_000_000
const STORAGE_KEY = 'notefast.previewQueue'

let state: QueueState = { items: [], currentIndex: 0 }
const listeners = new Set<() => void>()

// ─────────── sessionStorage 持久化 ───────────
// 壳层流程是「dispatch 事件 → 整页跳 /preview」（WKWebView load / location.href），
// 整页加载会销毁 JS 上下文，纯内存队列会被清空——队列落 sessionStorage
// （同源、同 webview 会话内跨整页跳转存活），新页面模块加载时恢复。

function queueStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

/** 序列化队列（纯函数，供测试） */
export function serializePreviewQueue(s: QueueState): string {
  return JSON.stringify(s)
}

/** 解析持久化的队列（纯函数，供测试）；非法/超限时返回 null 按空队列处理 */
export function parsePersistedQueue(raw: string | null): QueueState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<QueueState> | null
    if (!parsed || !Array.isArray(parsed.items)) return null
    const items: PreviewItem[] = []
    for (const it of parsed.items) {
      if (!it || typeof it.content !== 'string' || it.content.length > MAX_CONTENT_CHARS) return null
      items.push({
        title: typeof it.title === 'string' ? it.title : '',
        content: it.content,
        path: typeof it.path === 'string' ? it.path : '',
        contentHash: typeof it.contentHash === 'string' ? it.contentHash : '',
      })
    }
    const currentIndex =
      typeof parsed.currentIndex === 'number' && Number.isInteger(parsed.currentIndex)
        ? Math.min(Math.max(0, parsed.currentIndex), Math.max(0, items.length - 1))
        : 0
    return { items, currentIndex }
  } catch {
    return null
  }
}

function persistQueue(): void {
  try {
    const s = queueStorage()
    if (!s) return
    if (state.items.length === 0) s.removeItem(STORAGE_KEY)
    else s.setItem(STORAGE_KEY, serializePreviewQueue(state))
  } catch {
    // quota 等异常：放弃持久化，内存队列仍可用
  }
}

function restoreQueue(): void {
  const restored = parsePersistedQueue(queueStorage()?.getItem(STORAGE_KEY) ?? null)
  if (restored) state = restored
}

function emit(): void {
  for (const l of listeners) l()
}

function setState(patch: Partial<QueueState>): void {
  state = { ...state, ...patch }
  persistQueue()
  emit()
}

/** 推入队列（暴露给测试 / 高级用户直接调用；listener 路径走 pushPreviewItemFromEvent） */
export function pushPreviewItem(item: PreviewItem): boolean {
  if (typeof item.content !== 'string') return false
  if (item.content.length > MAX_CONTENT_CHARS) return false
  setState({ items: [...state.items, item] })
  return true
}

export function previewNext(): void {
  if (state.currentIndex + 1 < state.items.length) {
    setState({ currentIndex: state.currentIndex + 1 })
  }
}

export function previewPrev(): void {
  if (state.currentIndex > 0) {
    setState({ currentIndex: state.currentIndex - 1 })
  }
}

/** 丢弃当前项；展示原本的「下一项」（索引不变），最后一项时退回「上一项」 */
export function discardCurrentPreview(): void {
  if (state.currentIndex >= state.items.length) return
  const items = [
    ...state.items.slice(0, state.currentIndex),
    ...state.items.slice(state.currentIndex + 1),
  ]
  const currentIndex =
    state.currentIndex >= items.length ? Math.max(0, items.length - 1) : state.currentIndex
  setState({ items, currentIndex })
}

export function discardAllPreviews(): void {
  setState({ items: [], currentIndex: 0 })
}

/** 测试钩子：重置模块态到初始值（不要在产品代码里调用） */
export function __resetPreviewQueueForTests(): void {
  state = { items: [], currentIndex: 0 }
  try {
    queueStorage()?.removeItem(STORAGE_KEY)
  } catch {
    // 忽略
  }
  emit()
}

export function getPreviewQueueSnapshot(): QueueState {
  return state
}

// ─────────── 模块加载即挂监听（与 useTheme 同款） ───────────

if (typeof window !== 'undefined') {
  // 整页跳转（壳层 navigate /preview）后模块重建：先恢复跳转前已入队的预览项
  restoreQueue()

  window.addEventListener(PREVIEW_EVENT, (e) => {
    const detail = (e as CustomEvent<PreviewItem | undefined>).detail
    if (!detail || typeof detail.content !== 'string') return
    if (detail.content.length > MAX_CONTENT_CHARS) return
    pushPreviewItem({
      title: detail.title ?? '',
      content: detail.content,
      path: detail.path ?? '',
      contentHash: detail.contentHash ?? '',
    })
  })

  // 通知 shell：web 已就绪，可以 dispatch 启动前堆积的文件
  if (isNativeShell()) {
    // macOS WKWebView：通过既有 notefast 通道
    type NativeBridge = {
      webkit?: { messageHandlers?: { notefast?: { postMessage: (m: unknown) => void } } }
    }
    const w = window as unknown as NativeBridge
    w.webkit?.messageHandlers?.notefast?.postMessage({ type: 'webReady' })
    // Tauri：另走 __TAURI__.invoke('on_web_ready')，在 Tauri 集成时由具体壳层挂载
    void (async () => {
      const t = (window as unknown as { __TAURI__?: { core?: { invoke?: (cmd: string) => Promise<unknown> } } }).__TAURI__
      try {
        await t?.core?.invoke?.('on_web_ready')
      } catch {
        // Tauri 未注册 on_web_ready（开发态浏览器直访）—— 静默忽略
      }
    })()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): QueueState {
  return state
}

export interface UseFilePreviewQueueResult {
  current: PreviewItem | null
  total: number
  index: number
  hasNext: boolean
  hasPrev: boolean
  next: () => void
  prev: () => void
  discardCurrent: () => void
  discardAll: () => void
}

export function useFilePreviewQueue(): UseFilePreviewQueueResult {
  const { items, currentIndex } = useSyncExternalStore(subscribe, getSnapshot)
  const total = items.length
  const current = total > 0 ? items[Math.min(currentIndex, total - 1)] ?? null : null
  return {
    current,
    total,
    index: total > 0 ? currentIndex : -1,
    hasNext: currentIndex + 1 < total,
    hasPrev: currentIndex > 0,
    next: previewNext,
    prev: previewPrev,
    discardCurrent: discardCurrentPreview,
    discardAll: discardAllPreviews,
  }
}