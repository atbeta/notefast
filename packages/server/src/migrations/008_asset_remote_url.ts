import type { Database } from 'bun:sqlite'

/**
 * 008：assets 表加 remote_url（图床上传后外链，GET /assets/:id 302 用）。
 *
 * 图床上传是增强层：本地内容寻址存储始终是基底，remote_url 为可空附加列。
 * 无 remote_url 的 asset 行为与旧版完全一致（本地读取）。
 */
export const id = '008_asset_remote_url'
export const description = 'assets 表加 remote_url（图床外链，302 用）'
export function up(db: Database): void {
  db.exec('ALTER TABLE assets ADD COLUMN remote_url TEXT')
}
