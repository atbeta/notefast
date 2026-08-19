/**
 * shares 数据访问 —— 文档分享（公开只读链接）的存储层
 *
 * 独立表而非 blocks.properties：开关分享不触发 updated_at / hooks /
 * 重建索引 / change feed（不污染「最近更新」与同步游标）。
 *
 * 语义：
 * - 关闭分享即删除记录；重新开启生成全新 token，旧链接永久失效
 * - expires_at NULL = 永不过期；过期记录 = 不存在（读取时惰性清理，
 *   不需要后台任务），管理与公开端点统一只见到「未过期」的分享
 */

import { randomBytes } from 'node:crypto'
import type { getDb } from '../db'
import { nowTimestamp } from './blocks'

export type Db = ReturnType<typeof getDb>

/** 可选有效期（天数）；null / undefined = 永不过期 */
export type ShareExpiryDays = 1 | 7 | 30

export interface ShareRow {
  doc_id: string
  token: string
  expires_at: string | null
  created_at: string
}

function rowOf(r: unknown): ShareRow | null {
  return (r as ShareRow | undefined) ?? null
}

/** 过期判定与惰性清理：返回 null 表示无有效分享（从未开启 / 已关闭 / 已过期） */
function validOrCleanup(db: Db, row: ShareRow | null): ShareRow | null {
  if (!row) return null
  if (row.expires_at !== null && row.expires_at <= nowTimestamp()) {
    db.query('DELETE FROM shares WHERE doc_id = ?').run(row.doc_id)
    return null
  }
  return row
}

export function getShareByDocId(db: Db, docId: string): ShareRow | null {
  const row = rowOf(db.query('SELECT doc_id, token, expires_at, created_at FROM shares WHERE doc_id = ?').get(docId))
  return validOrCleanup(db, row)
}

function collectValidShareIds(
  db: Db,
  rows: Array<{ doc_id: string; expires_at: string | null }>,
): Set<string> {
  const now = nowTimestamp()
  const valid = new Set<string>()
  for (const r of rows) {
    if (r.expires_at !== null && r.expires_at <= now) {
      db.query('DELETE FROM shares WHERE doc_id = ?').run(r.doc_id)
    } else {
      valid.add(r.doc_id)
    }
  }
  return valid
}

/**
 * 批量列出当前有效分享的 doc_id 集合（供文档列表打「已分享」标记）。
 * 与单查路径同一语义：过期记录惰性清理后不返回。
 */
export function listSharedDocIds(db: Db): Set<string> {
  const rows = db.query('SELECT doc_id, expires_at FROM shares').all() as Array<{
    doc_id: string
    expires_at: string | null
  }>
  return collectValidShareIds(db, rows)
}

/** 只查本页文档的分享标记，避免列表接口扫全表 shares */
export function listSharedDocIdsFor(db: Db, docIds: string[]): Set<string> {
  if (docIds.length === 0) return new Set()
  const placeholders = docIds.map(() => '?').join(',')
  const rows = db
    .query(`SELECT doc_id, expires_at FROM shares WHERE doc_id IN (${placeholders})`)
    .all(...docIds) as Array<{ doc_id: string; expires_at: string | null }>
  return collectValidShareIds(db, rows)
}

export function getShareByToken(db: Db, token: string): ShareRow | null {
  const row = rowOf(db.query('SELECT doc_id, token, expires_at, created_at FROM shares WHERE token = ?').get(token))
  return validOrCleanup(db, row)
}

/** 开启分享：已开启时幂等返回现有记录；未开启生成新 token（32 位 hex）。
 *  ON CONFLICT DO NOTHING 防并发双 INSERT 撞主键（冲突即已被另一方创建，重读即可） */
export function createShare(db: Db, docId: string, expiryDays?: ShareExpiryDays | null): ShareRow {
  const existing = getShareByDocId(db, docId)
  if (existing) return existing
  const token = randomBytes(16).toString('hex')
  const expiresAt = expiryDays ? daysFromNow(expiryDays) : null
  db.query('INSERT INTO shares (doc_id, token, expires_at) VALUES (?, ?, ?) ON CONFLICT(doc_id) DO NOTHING').run(docId, token, expiresAt)
  return getShareByDocId(db, docId)!
}

/** 调整有效期（以现在为起点重新计算；null = 改为永不过期） */
export function setShareExpiry(db: Db, docId: string, expiryDays: ShareExpiryDays | null): ShareRow | null {
  const expiresAt = expiryDays ? daysFromNow(expiryDays) : null
  db.query('UPDATE shares SET expires_at = ? WHERE doc_id = ?').run(expiresAt, docId)
  return getShareByDocId(db, docId)
}

/** 关闭分享：返回是否实际删除（false = 本就没开启） */
export function deleteShare(db: Db, docId: string): boolean {
  return db.query('DELETE FROM shares WHERE doc_id = ?').run(docId).changes > 0
}

/** 文档删除时级联清理（软删除即切断公开链接；恢复文档不复活旧链接，需重新开启） */
export function deleteSharesByDocIds(db: Db, docIds: string[]): void {
  if (docIds.length === 0) return
  const placeholders = docIds.map(() => '?').join(',')
  db.query(`DELETE FROM shares WHERE doc_id IN (${placeholders})`).run(...(docIds as [string, ...string[]]))
}

/** 笔记本删除时级联清理其下全部文档的分享 */
export function deleteSharesByNotebook(db: Db, notebookId: string): void {
  db.query('DELETE FROM shares WHERE doc_id IN (SELECT id FROM blocks WHERE notebook_id = ?)').run(notebookId)
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}
