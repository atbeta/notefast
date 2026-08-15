import type { Database } from 'bun:sqlite'

/**
 * 017：服务端应用日志环形表（app_logs）。
 *
 * 与 client_errors（前端错误埋点）互补：本表记录服务端事件——
 * 维护循环结果、慢请求、AI 调用失败、启动告警、手动维护操作等。
 * 这是「设置 → 维护」页的数据源，让用户侧不再黑盒。
 *
 * 滚动策略：
 *  - 时间：仅保留 30 天（对齐 tombstone 保留期）
 *  - 数量：最多 2000 行（防极端情况膨胀）
 * 由 initAppLogs() 在 server.start() 阶段清理；维护循环兜底再清一次。
 */
export const id = '017_app_logs'
export const description = 'server-side app logs (maintenance results, slow requests, AI failures)'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         TEXT NOT NULL DEFAULT (datetime('now')),
      level      TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
      source     TEXT NOT NULL,
      message    TEXT NOT NULL,
      fields     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_app_logs_ts ON app_logs(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_app_logs_level ON app_logs(level);
  `)
}
