import type { Database } from 'bun:sqlite'

/**
 * 009：assets 表加 upload_error（图床上传失败原因，持久化可查）。
 *
 * 图床上传失败时写原因（ENOENT / 非零退出 / 输出无 URL / PICFAST_URL 未配置等），
 * 成功时清空并写 remote_url。设置页「图床上传」据此展示最近失败，解决
 * 「静默降级看不见错误」的问题。
 */
export const id = '009_asset_upload_error'
export const description = 'assets 表加 upload_error（图床上传失败原因）'
export function up(db: Database): void {
  db.exec('ALTER TABLE assets ADD COLUMN upload_error TEXT')
}
