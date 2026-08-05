import type { Database } from 'bun:sqlite'

/**
 * 010：assets 表加 upload_attempted_at（最近一次图床上传尝试时间）。
 *
 * 语义修正：设置页「最近一次上传失败」应按「最近上传尝试」判定——
 * 最近一次尝试成功就不该再显示历史失败。原查询取任意 upload_error 非空的行，
 * 失败过一次就永远显示（无关闭按钮、后续成功也不消失）。
 */
export const id = '010_asset_upload_attempted_at'
export const description = 'assets 表加 upload_attempted_at（最近上传尝试时间）'
export function up(db: Database): void {
  db.exec('ALTER TABLE assets ADD COLUMN upload_attempted_at TEXT')
}
