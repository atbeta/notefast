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
import { streamSSE } from 'hono/streaming'
import { subscribeDocChanges } from '../services/docEvents'

const HEARTBEAT_MS = 25_000

const events = new Hono()

events.get('/', (c) => {
  return streamSSE(c, async (sse) => {
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
  })
})

export default events
