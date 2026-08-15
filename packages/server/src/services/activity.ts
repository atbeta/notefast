/**
 * 活跃度信号：记录最近一次 API 请求时间。
 *
 * 用途：后台维护（tombstone purge 大事务）避开用户活跃时段——
 * 维护循环执行前检查「距上次请求是否足够久」，不够则跳过本轮，下轮再试。
 * 避免 6 小时一次的自动维护撞上用户正在操作（SQLite 单写锁，大事务会卡住读写）。
 */

let lastRequestAt = 0

/** 记录一次请求（app.ts 中间件调用；毫秒时间戳） */
export function noteRequestActivity(): void {
  lastRequestAt = Date.now()
}

/** 距上次请求的毫秒数（从未有请求返回 Infinity） */
export function msSinceLastRequest(): number {
  if (lastRequestAt === 0) return Infinity
  return Date.now() - lastRequestAt
}

/** 维护循环用：距上次请求 ≥ idleMs 才算空闲，可以跑大事务 */
export function isIdleEnoughForMaintenance(idleMs: number): boolean {
  return msSinceLastRequest() >= idleMs
}
