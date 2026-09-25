/**
 * 投影文件映射：磁盘相对路径 ↔ 文档 id（RFC 0007 D2/D6）。
 *
 * 一行 = 一个投影文件。这是入方向（文件 → 库）的入口索引：
 * watcher 拿到一个 `rel_path`，要立刻知道它对应哪篇文档、上次见到的内容是什么。
 *
 * 与 vault 的 `vault_files` 的关键差别：这里**没有** `meta_hash` / `deleted_at`
 * 的回收站语义——投影模式下元数据不进 frontmatter、删除由库的回收站负责，
 * 这两个字段是为「双向对等」而生的，本方案不需要（RFC 0007 D1/D3/D9）。
 */

import type { getDb } from '../db'

type Db = ReturnType<typeof getDb>

export interface ProjectionFileRow {
  notebook_id: string
  /** 文件身份：相对投影文件夹的 POSIX 路径 */
  rel_path: string
  /** 文档身份：文档根 block id */
  doc_id: string
  /** 上次导入 / 写回时见到的内容 sha256；变更短路与冲突检测的依据 */
  content_sha256: string
  size: number
  mtime_ms: number
  /** 写回结束时 doc.updated_at，用于识别「这是我们自己写的」 */
  doc_updated_at: string
  updated_at: string
}

export function getProjectionFileByPath(db: Db, notebookId: string, relPath: string): ProjectionFileRow | null {
  return (
    (db
      .query('SELECT * FROM projection_files WHERE notebook_id = ? AND rel_path = ?')
      .get(notebookId, relPath) as ProjectionFileRow | undefined) ?? null
  )
}

export function getProjectionFileByDoc(db: Db, notebookId: string, docId: string): ProjectionFileRow | null {
  return (
    (db
      .query('SELECT * FROM projection_files WHERE notebook_id = ? AND doc_id = ?')
      .get(notebookId, docId) as ProjectionFileRow | undefined) ?? null
  )
}

export function listProjectionFiles(db: Db, notebookId: string): ProjectionFileRow[] {
  return db
    .query('SELECT * FROM projection_files WHERE notebook_id = ? ORDER BY rel_path ASC')
    .all(notebookId) as ProjectionFileRow[]
}

export interface UpsertProjectionFileInput {
  notebook_id: string
  rel_path: string
  doc_id: string
  content_sha256: string
  size: number
  mtime_ms: number
  doc_updated_at: string
}

/**
 * 写入 / 更新映射行。
 *
 * 同一 doc 若换了路径（用户在外部改名），旧行必须先删——`doc_id` 唯一，
 * 否则会插入失败。调用方负责先 `moveProjectionFile` 或 `deleteProjectionFileByDoc`。
 */
export function upsertProjectionFile(db: Db, row: UpsertProjectionFileInput): void {
  const now = new Date().toISOString()
  db.query(
    `INSERT INTO projection_files
       (notebook_id, rel_path, doc_id, content_sha256, size, mtime_ms, doc_updated_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(notebook_id, rel_path) DO UPDATE SET
       doc_id = excluded.doc_id,
       content_sha256 = excluded.content_sha256,
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       doc_updated_at = excluded.doc_updated_at,
       updated_at = excluded.updated_at`,
  ).run(
    row.notebook_id,
    row.rel_path,
    row.doc_id,
    row.content_sha256,
    row.size,
    row.mtime_ms,
    row.doc_updated_at,
    now,
  )
}

/** 只更新内容指纹（写回成功后调用；路径与文档不变） */
export function touchProjectionFileAfterWrite(
  db: Db,
  notebookId: string,
  docId: string,
  contentSha256: string,
  size: number,
  mtimeMs: number,
  docUpdatedAt: string,
): void {
  db.query(
    `UPDATE projection_files
       SET content_sha256 = ?, size = ?, mtime_ms = ?, doc_updated_at = ?, updated_at = ?
     WHERE notebook_id = ? AND doc_id = ?`,
  ).run(contentSha256, size, mtimeMs, docUpdatedAt, new Date().toISOString(), notebookId, docId)
}

/** 文件在外部被改名 / 移动：同一文档换路径 */
export function moveProjectionFile(db: Db, notebookId: string, fromRel: string, toRel: string): void {
  db.query('UPDATE projection_files SET rel_path = ?, updated_at = ? WHERE notebook_id = ? AND rel_path = ?').run(
    toRel,
    new Date().toISOString(),
    notebookId,
    fromRel,
  )
}

export function deleteProjectionFileByPath(db: Db, notebookId: string, relPath: string): void {
  db.query('DELETE FROM projection_files WHERE notebook_id = ? AND rel_path = ?').run(notebookId, relPath)
}

export function deleteProjectionFileByDoc(db: Db, notebookId: string, docId: string): void {
  db.query('DELETE FROM projection_files WHERE notebook_id = ? AND doc_id = ?').run(notebookId, docId)
}

/**
 * 找「内容相同但路径已经不在磁盘上」的映射行 —— 移动检测的依据（RFC 0007 D6）。
 *
 * 使用场景：文件从 A 消失、出现在 B。若在 A 上我们保留了映射行（见 ingest 的
 * removeProjectionFile 注释），这里就能配对出「同一个文档被移到了 B」，
 * 而不是新建一篇。`staleRelPaths` 是调用方当前扫到的磁盘文件集合，
 * 用于排除「映射行还在、文件也还在」的正常情况。
 */
export function findMovedProjectionFile(
  db: Db,
  notebookId: string,
  sha: string,
  staleRelPaths: ReadonlySet<string>,
  excludeDocId?: string,
): ProjectionFileRow | null {
  const candidates = db
    .query(
      'SELECT * FROM projection_files WHERE notebook_id = ? AND content_sha256 = ? ORDER BY updated_at DESC',
    )
    .all(notebookId, sha) as ProjectionFileRow[]
  for (const row of candidates) {
    if (excludeDocId && row.doc_id === excludeDocId) continue
    if (staleRelPaths.has(row.rel_path)) continue
    return row
  }
  return null
}
