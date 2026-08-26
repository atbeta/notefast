import type { Database } from 'bun:sqlite'

/**
 * 019：assets 加 filename 列（原始文件名）。
 *
 * 背景：asset ID = 内容 sha256，落盘 data/media/<sha256> 无扩展名。用户侧
 * 看到 `![...](asset:7f3c...)` 无法知道这图是什么、在哪——资源页也定位不到
 * 本地文件。给 assets 补 filename（上传/导入时的原始文件名，可空：存量 &
 * 无法获取的场景为空），资源页据此显示可读名 + 可复制本地路径。
 *
 * 空值处理：存量资产无 filename，资源页回退显示哈希短前缀；不强推补齐。
 */
export const id = '019_assets_filename'
export const description = 'assets gain original filename column / local-file locating'

export function up(db: Database): void {
  // SQLite 无 ADD COLUMN IF NOT EXISTS；列已存在时（旧引擎抹掉迁移记录、或
  // 上一轮事务只提交了 DDL）不能让启动崩溃。
  const columns = db.query(`PRAGMA table_info(assets)`).all() as Array<{ name: string }>
  if (!columns.some((c) => c.name === 'filename')) {
    db.exec(`ALTER TABLE assets ADD COLUMN filename TEXT`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_filename ON assets(filename)`)
}
