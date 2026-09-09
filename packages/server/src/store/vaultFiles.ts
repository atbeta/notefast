/**
 * vault_files 数据访问 —— 文件 ↔ 文档映射表的统一读写入口（RFC 0002）
 *
 * 一行 = 一个 vault 相对路径与一篇文档的绑定。所有 vault 相关 SQL 只在这里，
 * ingest / watcher / writeback 不得另开旁路。
 */

import type { getDb } from '../db'

type Db = ReturnType<typeof getDb>

export type NotebookKind = 'db' | 'vault'

export interface VaultFileRow {
  notebook_id: string
  rel_path: string
  doc_id: string
  content_sha256: string
  size: number
  mtime_ms: number
  ingested_at: string
  /** ingest 完成时文档根的 updated_at；写回订阅者据此区分「ingest 回声」与「SQLite 端真实编辑」 */
  doc_updated_at: string
  deleted_at: string | null
  /** 用户手写 frontmatter 原文（不含首尾 `---`）；写回透传（RFC 0003 阶段 B） */
  frontmatter_raw: string | null
  /** sha256(JSON[tags, ai_exclude, status])，修正元数据变更的回声判定（阶段 B） */
  meta_hash: string | null
}

export interface UpsertVaultFileInput {
  notebook_id: string
  rel_path: string
  doc_id: string
  content_sha256: string
  size: number
  mtime_ms: number
  doc_updated_at: string
  frontmatter_raw: string | null
  meta_hash: string | null
}

export function getVaultFileByPath(db: Db, notebookId: string, relPath: string): VaultFileRow | null {
  return (
    (db
      .query('SELECT * FROM vault_files WHERE notebook_id = ? AND rel_path = ?')
      .get(notebookId, relPath) as VaultFileRow | undefined) ?? null
  )
}

export function getVaultFileByDocId(db: Db, docId: string): VaultFileRow | null {
  return (db.query('SELECT * FROM vault_files WHERE doc_id = ?').get(docId) as VaultFileRow | undefined) ?? null
}

/** 已删除（文件消失）且内容 sha 相同的映射：用于 rename / 重现配对 */
export function findDeletedVaultFileBySha(db: Db, notebookId: string, sha: string): VaultFileRow | null {
  return (
    (db
      .query(
        `SELECT * FROM vault_files
         WHERE notebook_id = ? AND content_sha256 = ? AND deleted_at IS NOT NULL
         ORDER BY deleted_at DESC LIMIT 1`,
      )
      .get(notebookId, sha) as VaultFileRow | undefined) ?? null
  )
}

export function listVaultFiles(db: Db, notebookId: string, opts: { includeDeleted?: boolean } = {}): VaultFileRow[] {
  const where = opts.includeDeleted ? '' : 'AND deleted_at IS NULL'
  return db
    .query(`SELECT * FROM vault_files WHERE notebook_id = ? ${where} ORDER BY rel_path ASC`)
    .all(notebookId) as VaultFileRow[]
}

export function upsertVaultFile(db: Db, input: UpsertVaultFileInput): void {
  db.query(
    `INSERT INTO vault_files (notebook_id, rel_path, doc_id, content_sha256, size, mtime_ms, ingested_at, doc_updated_at, deleted_at, frontmatter_raw, meta_hash)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, NULL, ?, ?)
     ON CONFLICT(notebook_id, rel_path) DO UPDATE SET
       doc_id = excluded.doc_id,
       content_sha256 = excluded.content_sha256,
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       ingested_at = excluded.ingested_at,
       doc_updated_at = excluded.doc_updated_at,
       deleted_at = NULL,
       frontmatter_raw = excluded.frontmatter_raw,
       meta_hash = excluded.meta_hash`,
  ).run(
    input.notebook_id,
    input.rel_path,
    input.doc_id,
    input.content_sha256,
    input.size,
    input.mtime_ms,
    input.doc_updated_at,
    input.frontmatter_raw,
    input.meta_hash,
  )
}

/** 文件消失：保留映射行，打 deleted_at（文档同时进回收站，由调用方处理） */
export function markVaultFileDeleted(db: Db, notebookId: string, relPath: string): void {
  db.query(
    `UPDATE vault_files SET deleted_at = datetime('now') WHERE notebook_id = ? AND rel_path = ? AND deleted_at IS NULL`,
  ).run(notebookId, relPath)
}

/** rename：把映射从旧路径搬到新路径（文档 id 不变） */
export function moveVaultFile(db: Db, notebookId: string, fromRelPath: string, toRelPath: string): void {
  db.query('DELETE FROM vault_files WHERE notebook_id = ? AND rel_path = ?').run(notebookId, toRelPath)
  db.query(
    `UPDATE vault_files SET rel_path = ?, deleted_at = NULL, ingested_at = datetime('now')
     WHERE notebook_id = ? AND rel_path = ?`,
  ).run(toRelPath, notebookId, fromRelPath)
}

export function deleteVaultFileRow(db: Db, notebookId: string, relPath: string): void {
  db.query('DELETE FROM vault_files WHERE notebook_id = ? AND rel_path = ?').run(notebookId, relPath)
}

/** 写回后刷新 sha / mtime（文档内容未变，doc_updated_at 一并对齐，让紧随的 watcher 事件成为 no-op） */
export function touchVaultFileAfterWrite(
  db: Db,
  notebookId: string,
  relPath: string,
  patch: {
    content_sha256: string
    size: number
    mtime_ms: number
    doc_updated_at: string
    frontmatter_raw?: string | null
    meta_hash?: string | null
  },
): void {
  const args: (string | number | null)[] = [patch.content_sha256, patch.size, patch.mtime_ms, patch.doc_updated_at]
  let extraSql = ''
  if (patch.frontmatter_raw !== undefined) {
    extraSql += ', frontmatter_raw = ?'
    args.push(patch.frontmatter_raw)
  }
  if (patch.meta_hash !== undefined) {
    extraSql += ', meta_hash = ?'
    args.push(patch.meta_hash)
  }
  args.push(notebookId, relPath)
  db.query(
    `UPDATE vault_files SET content_sha256 = ?, size = ?, mtime_ms = ?, doc_updated_at = ?, ingested_at = datetime('now')${extraSql}
     WHERE notebook_id = ? AND rel_path = ?`,
  ).run(...args)
}

// ───────────────────── notebooks.kind ─────────────────────

export interface NotebookVaultBinding {
  kind: NotebookKind
  vault_root: string | null
}

export function getNotebookVaultBinding(db: Db, notebookId: string): NotebookVaultBinding | null {
  const row = db.query('SELECT kind, vault_root FROM notebooks WHERE id = ?').get(notebookId) as
    | { kind: string; vault_root: string | null }
    | undefined
  if (!row) return null
  return { kind: row.kind === 'vault' ? 'vault' : 'db', vault_root: row.vault_root ?? null }
}

export function bindNotebookToVault(db: Db, notebookId: string, vaultRoot: string): void {
  db.query(`UPDATE notebooks SET kind = 'vault', vault_root = ?, updated_at = datetime('now') WHERE id = ?`).run(
    vaultRoot,
    notebookId,
  )
}

export function unbindNotebookVault(db: Db, notebookId: string): void {
  db.query(`UPDATE notebooks SET kind = 'db', vault_root = NULL, updated_at = datetime('now') WHERE id = ?`).run(
    notebookId,
  )
}
