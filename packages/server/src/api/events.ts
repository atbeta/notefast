/**
 * GET /api/v1/events — 文档变更 SSE 订阅端点
 *
 * 事件：
 * - event: doc  → data: { doc_id, kind: created|updated|deleted, at }
 * - event: ping → 心跳（25s），防反向代理空闲断连
 *
 * 鉴权走全局 authMiddleware（Basic / Bearer / 会话 cookie 均可）。
 * Web 端用 fetch 流式读取（EventSource 无法带 Authorization 头）。
 */

import { Hono } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { subscribeDocChanges } from '../services/docEvents'

const HEARTBEAT_MS = 25_000

/** 活跃的 SSE 订阅流：服务端停机时需主动关闭，否则 drain 会等满强退超时（~10s） */
const activeStreams = new Set<SSEStreamingApi>()

/** 关闭全部活跃 SSE 订阅（停机入口调用，让 server.stop 的 drain 快速完成） */
export function closeAllSseStreams(): void {
  for (const sse of [...activeStreams]) {
    try { void sse.close() } catch { /* ignore */ }
  }
  activeStreams.clear()
}

const events = new Hono()

events.get('/', (c) => {
  return streamSSE(c, async (sse) => {
    activeStreams.add(sse)
    try {
      const unsubscribe = subscribeDocChanges((ev) => {
        sse.writeSSE({ event: 'doc', data: JSON.stringify(ev) }).catch(() => {})
      })
      const heartbeat = setInterval(() => {
        sse.writeSSE({ event: 'ping', data: '{}' }).catch(() => {})
      }, HEARTBEAT_MS)

      // 保持连接直到客户端断开
      await new Promise<void>((resolve) => {
        sse.onAbort(() => {
          clearInterval(heartbeat)
          unsubscribe()
          resolve()
        })
      })
    } finally {
      activeStreams.delete(sse)
    }
  })
})

export default events
