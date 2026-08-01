import type { Database } from 'bun:sqlite'

export const id = '004_doc_snapshots'
export const description = 'separate whole-doc snapshots from block revisions'

export function up(db: Database): void {
  // 独立整篇快照表：按 doc_id 维度、独立上限，避免 doc-root 的块级修订槽位被快照挤占
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_snapshots (
      doc_id       TEXT NOT NULL,
      rev          INTEGER NOT NULL,
      content      TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      actor        TEXT NOT NULL DEFAULT 'editor',
      created_at   TEXT NOT NULL,
      PRIMARY KEY (doc_id, rev)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_snapshots_doc ON doc_snapshots(doc_id, rev DESC)`)

  // 迁移旧数据：v9（003）曾把整篇快照以「文档根 block 的 revision」形式存进 block_revisions。
  // 从 v9 升级到 v10 的库，把这些 doc-root 快照搬进 doc_snapshots，再从 block_revisions 清掉，
  // 避免历史被标记为块级修改或与真实标题修订混淆。
  // （全新库从 v8 直升 v10 时此处为空，天然幂等。）
  const staleRootSnapshots = db
    .query(
      `SELECT r.block_id AS doc_id, r.rev, r.content, r.content_hash, r.actor, r.created_at
       FROM block_revisions r
       JOIN blocks b ON b.id = r.block_id
       WHERE b.type = 'document'`,
    )
    .all() as Array<{
    doc_id: string
    rev: number
    content: string
    content_hash: string
    actor: string
    created_at: string
  }>
  if (staleRootSnapshots.length > 0) {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO doc_snapshots (doc_id, rev, content, content_hash, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const del = db.prepare(`DELETE FROM block_revisions WHERE block_id = ? AND rev = ?`)
    for (const s of staleRootSnapshots) {
      insert.run(s.doc_id, s.rev, s.content, s.content_hash, s.actor, s.created_at)
      del.run(s.doc_id, s.rev)
    }
  }
}
