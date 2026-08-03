/**
 * NoteFast Server CLI 入口（Docker / bun dev / 生产单进程）
 *
 * 只是 createApp() 的宿主：负责 Bun.serve、优雅停机信号处理、启动告警。
 * 业务/路由/初始化全部在 app.ts 的 createApp() 中（可被原生客户端等复用）。
 */

import { createApp } from './app'
import { isAuthEnabled } from './middleware/auth'
import { closeAllSseStreams } from './api/events'

const PORT = parseInt(process.env.PORT || '3140', 10)
const DATA_DIR = process.env.DATA_DIR || './data'

const handle = createApp({ dataDir: DATA_DIR })

await handle.start()

const server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch: handle.app.fetch,
  // idleTimeout 保持 Bun 默认（10s）：普通 API 连接快速回收；
  // SSE 长连接由 createApp 内的 relaxSseIdleTimeout 经 server.timeout 单独放宽
})
handle.attachServer(server)

console.log(`🚀 NoteFast Server running at http://localhost:${PORT}`)
console.log(`📦 Default notebook: ${handle.notebookId}`)
console.log(`🔧 MCP endpoint: http://localhost:${PORT}/mcp`)

// 未配置任何鉴权时所有请求以 admin 放行（本地开发便利设计）；
// 监听 0.0.0.0，误暴露到公网即全面失防——启动时醒目告警，不做静默放行
if (!isAuthEnabled()) {
  console.warn('⚠️  未配置任何鉴权（API_TOKEN / AUTH_PASSWORD / READ_TOKEN / WRITE_TOKEN）')
  console.warn('⚠️  所有 API/MCP 请求将以 admin 权限放行，仅适用于本地开发或可信内网')
  console.warn('⚠️  暴露到公网前请务必配置鉴权（见 .env.example）')
}

// 优雅停机：docker restart / systemd stop 的 SIGTERM 先停止接收新连接，
// 等在飞请求（写事务 / SSE / AI 流）drain 完再退出；超时强退，避免无限挂起
// （SSE 长连接本身不会自然结束，只能靠超时兜底）。
// SQLite 事务在 bun:sqlite 中是同步的，信号 handler 不会插在事务中间执行，
// drain 主要保护 async handler 的跨 await 写序列（sync push、备份、AI 调用）。
const SHUTDOWN_TIMEOUT_MS = 10_000
let shuttingDown = false
function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n🛑 收到 ${signal}，停止接收新连接，等待在飞请求完成…`)
  // 主动关闭 SSE 订阅流（/api/v1/events 是永久长连接），否则 drain 会等满强退超时
  try { closeAllSseStreams() } catch { /* ignore */ }
  const forceTimer = setTimeout(() => {
    console.error(`⚠️ ${SHUTDOWN_TIMEOUT_MS}ms 内未能 drain，强制退出`)
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  forceTimer.unref()
  // stop(false)：不再 accept，但等已建立的连接处理完；DB 清理由 exit handler 统一做
  void server.stop(false).then(() => {
    clearTimeout(forceTimer)
    process.exit(0)
  })
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
