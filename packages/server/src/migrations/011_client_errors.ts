import type { Database } from 'bun:sqlite'

/**
 * 011：客户端错误埋点表（client_errors）。
 *
 * 前端用 errorReporter 集中上报 componentDidCatch / window.onerror /
 * unhandledrejection，写到本地 SQLite。本表：
 *  - 仅 7 天滚动（启动时由 initClientErrors 清理 expires）
 *  - hash 字段：客户端对 stack 截断前 N 行做 sha256，用作去重聚合键
 *  - user_id：鉴权用户的稳定 id（来自 authMiddleware），未登录为空
 *
 * 这是稳定性观测的最小骨架。后续 ops UI 拉最近错误用同一张表。
 */
export const id = '011_client_errors'
export const description = 'client error reports from web (componentDidCatch / onerror / unhandledrejection)'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_errors (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at      TEXT NOT NULL DEFAULT (datetime('now')),
      source           TEXT NOT NULL,
      message          TEXT NOT NULL,
      stack            TEXT,
      component_stack  TEXT,
      url              TEXT,
      user_agent       TEXT,
      app_version      TEXT,
      user_id          TEXT,
      hash             TEXT NOT NULL,
      extra            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_client_errors_received_at ON client_errors(received_at);
    CREATE INDEX IF NOT EXISTS idx_client_errors_hash ON client_errors(hash);
  `)
}