/**
 * AutoLink suggestion store — SQLite 后端
 *
 * 数据模型见 .ai/ai-first-tier1.md 第 1 节。
 * 双轴状态：
 *   action_status: suggested | applied | reverted | failed | superseded
 *   review_status: unreviewed | accepted | dismissed
 *
 * 关键不变量：
 * - 同 source_block_id 出现新内容 hash → 旧 suggestion 全部 superseded（防止旧分析污染 Inbox）
 * - apply 事务内：INSERT block_refs → 拿 created_ref_id → UPDATE suggestion
 * - revert 事务内：DELETE block_refs by created_ref_id → UPDATE suggestion reverted
 * - 同一 suggestion 二次 apply 幂等（不重复插 ref）
 */

import type Database from 'bun:sqlite'
import { getDb } from '../db'

// ───────────────────── Types ─────────────────────

export type ActionStatus = 'suggested' | 'applied' | 'reverted' | 'failed' | 'superseded'
export type ReviewStatus = 'unreviewed' | 'accepted' | 'dismissed'
export type ScoreKind = 'fts_rank' | 'embedding' | 'hybrid'

export interface Candidate {
  blockId: string
  docId: string
  docTitle: string
  snippet: string
  confidence: number
  scoreKind: ScoreKind
}

export interface AutoLinkSuggestion {
  id: string
  sourceBlockId: string
  sourceContentHash: string
  sourceUpdatedAt: string
  notebookId: string
  anchor: string
  kind: string
  candidates: Candidate[]
  actionStatus: ActionStatus
  reviewStatus: ReviewStatus
  createdRefId: number | null
  appliedTargetId: string | null
  scoreKind: ScoreKind
  model: string | null
  error: string | null
  createdAt: string
  appliedAt: string | null
  reviewedAt: string | null
}

export interface ListFilter {
  docId?: string
  sourceBlockId?: string
  actionStatus?: ActionStatus | ActionStatus[]
  reviewStatus?: ReviewStatus | ReviewStatus[]
  /** 默认 200 */
  limit?: number
  /** 按 created_at DESC（默认） */
  order?: 'asc' | 'desc'
}

// ───────────────────── Row ↔ Object ─────────────────────

interface SuggestionRow {
  id: string
  source_block_id: string
  source_content_hash: string
  source_updated_at: string
  notebook_id: string
  anchor: string
  kind: string
  candidates: string
  action_status: string
  review_status: string
  created_ref_id: number | null
  applied_target_id: string | null
  score_kind: string | null
  model: string | null
  error: string | null
  created_at: string
  applied_at: string | null
  reviewed_at: string | null
}

function rowToSuggestion(row: SuggestionRow): AutoLinkSuggestion {
  let candidates: Candidate[] = []
  try {
    const parsed = JSON.parse(row.candidates)
    if (Array.isArray(parsed)) candidates = parsed as Candidate[]
  } catch {
    candidates = []
  }
  return {
    id: row.id,
    sourceBlockId: row.source_block_id,
    sourceContentHash: row.source_content_hash,
    sourceUpdatedAt: row.source_updated_at,
    notebookId: row.notebook_id,
    anchor: row.anchor,
    kind: row.kind,
    candidates,
    actionStatus: row.action_status as ActionStatus,
    reviewStatus: row.review_status as ReviewStatus,
    createdRefId: row.created_ref_id,
    appliedTargetId: row.applied_target_id,
    scoreKind: (row.score_kind as ScoreKind | null) ?? 'fts_rank',
    model: row.model,
    error: row.error,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
    reviewedAt: row.reviewed_at,
  }
}

// ───────────────────── Insert ─────────────────────

/**
 * 新增一批 suggestions。
 * 副作用：同 source_block_id 下、与新 hash 不一致的、状态非终态（superseded/failed）的旧记录 → superseded
 */
export function addSuggestions(suggestions: AutoLinkSuggestion[]): void {
  if (suggestions.length === 0) return
  const db = getDb()

  db.transaction(() => {
    // 同 source_block_id 集合
    const sourceIds = [...new Set(suggestions.map((s) => s.sourceBlockId))]
    const hashes = [...new Set(suggestions.map((s) => s.sourceContentHash))]

    // 把同 source 不同 hash 的、活跃 suggestion 全部 superseded
    if (sourceIds.length > 0) {
      const placeholders = sourceIds.map(() => '?').join(',')
      const hashPlaceholders = hashes.map(() => '?').join(',')
      db.query(
        `UPDATE autolink_suggestions
         SET action_status = 'superseded', reviewed_at = COALESCE(reviewed_at, datetime('now'))
         WHERE source_block_id IN (${placeholders})
           AND source_content_hash NOT IN (${hashPlaceholders})
           AND action_status NOT IN ('superseded', 'failed', 'reverted')`,
      ).run(...[...sourceIds, ...hashes] as string[])
    }

    // 插入新 rows
    const stmt = db.query(
      `INSERT INTO autolink_suggestions
        (id, source_block_id, source_content_hash, source_updated_at, notebook_id,
         anchor, kind, candidates, action_status, review_status, score_kind, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    for (const s of suggestions) {
      stmt.run(
        s.id,
        s.sourceBlockId,
        s.sourceContentHash,
        s.sourceUpdatedAt,
        s.notebookId,
        s.anchor,
        s.kind,
        JSON.stringify(s.candidates),
        s.actionStatus,
        s.reviewStatus,
        s.scoreKind,
        s.model,
        s.createdAt,
      )
    }
  })()
}

// ───────────────────── Apply / Revert / Dismiss (transactions) ─────────────────────

export interface ApplyResult {
  applied: boolean
  refId?: number
  reason?: 'not_found' | 'already_applied' | 'invalid_candidate' | 'target_deleted' | 'ref_already_exists'
  targetBlockId?: string
}

/**
 * 接受一条 suggestion。
 * - 已被 applied 的 suggestion → 幂等返回原 refId
 * - 在事务内 INSERT block_refs，拿 created_ref_id 后 UPDATE suggestion
 * - 已存在同 (source, target) ref → no-op（避免重复）
 */
export function applySuggestion(
  suggestionId: string,
  candidateIndex: number = 0,
  refType: 'ai_suggested' | 'ai_auto' = 'ai_suggested',
): ApplyResult {
  const db = getDb()

  return db.transaction((): ApplyResult => {
    const row = db
      .query('SELECT * FROM autolink_suggestions WHERE id = ?')
      .get(suggestionId) as SuggestionRow | undefined
    if (!row) return { applied: false, reason: 'not_found' }
    const s = rowToSuggestion(row)

    // 幂等：已 applied → 返回原 ref_id
    if (s.actionStatus === 'applied' && s.createdRefId != null) {
      return { applied: false, refId: s.createdRefId, reason: 'already_applied', targetBlockId: s.appliedTargetId ?? undefined }
    }

    const cand = s.candidates[candidateIndex]
    if (!cand) return { applied: false, reason: 'invalid_candidate' }

    // 检查 target block 是否还存在
    const targetExists = db.query('SELECT 1 FROM blocks WHERE id = ?').get(cand.blockId)
    if (!targetExists) {
      // 标 failed 让用户知道
      db.query(
        `UPDATE autolink_suggestions
         SET action_status='failed', error='target_block_deleted'
         WHERE id=?`,
      ).run(suggestionId)
      return { applied: false, reason: 'target_deleted' }
    }

    // 查重：同 (source, target) ref 是否已存在
    const dup = db
      .query('SELECT id FROM block_refs WHERE source_id = ? AND target_id = ?')
      .get(s.sourceBlockId, cand.blockId) as { id: number } | undefined
    if (dup) {
      // 关联到已存在的 ref，不重复 INSERT
      db.query(
        `UPDATE autolink_suggestions
         SET action_status='applied', created_ref_id=?, applied_target_id=?, applied_at=datetime('now')
         WHERE id=?`,
      ).run(dup.id, cand.blockId, suggestionId)
      return { applied: false, refId: dup.id, reason: 'ref_already_exists', targetBlockId: cand.blockId }
    }

    // INSERT ref，拿 id
    const inserted = db
      .query(
        `INSERT INTO block_refs (source_id, target_id, ref_type) VALUES (?, ?, ?)
         RETURNING id`,
      )
      .get(s.sourceBlockId, cand.blockId, refType) as { id: number }

    db.query(
      `UPDATE autolink_suggestions
       SET action_status='applied', created_ref_id=?, applied_target_id=?, applied_at=datetime('now')
       WHERE id=?`,
    ).run(inserted.id, cand.blockId, suggestionId)

    return { applied: true, refId: inserted.id, targetBlockId: cand.blockId }
  })()
}

export interface RevertResult {
  reverted: boolean
  reason?: 'not_found' | 'not_applied' | 'ref_already_gone'
}

/**
 * 撤销一条已 applied 的 suggestion。
 * 按 created_ref_id 精确删除（不依赖 source/target 对），
 * 然后把 suggestion 标记 reverted，并放回 review_status=unreviewed（用户可再次接受）。
 */
export function revertSuggestion(suggestionId: string): RevertResult {
  const db = getDb()

  return db.transaction((): RevertResult => {
    const row = db
      .query('SELECT * FROM autolink_suggestions WHERE id = ?')
      .get(suggestionId) as SuggestionRow | undefined
    if (!row) return { reverted: false, reason: 'not_found' }
    const s = rowToSuggestion(row)

    if (s.actionStatus !== 'applied' || s.createdRefId == null) {
      return { reverted: false, reason: 'not_applied' }
    }

    // 按 id 精确删除（不会误删其他 ref）
    const delResult = db.query('DELETE FROM block_refs WHERE id = ?').run(s.createdRefId)

    db.query(
      `UPDATE autolink_suggestions
       SET action_status='reverted', review_status='unreviewed',
           applied_at=NULL, created_ref_id=NULL, applied_target_id=NULL,
           reviewed_at=datetime('now')
       WHERE id=?`,
    ).run(suggestionId)

    return { reverted: true, reason: delResult.changes === 0 ? 'ref_already_gone' : undefined }
  })()
}

export interface DismissResult {
  dismissed: boolean
  reason?: 'not_found' | 'already_dismissed'
}

/**
 * 用户主动忽略一条 suggestion。
 * 不删除记录，便于后续审计 / 撤销忽略。
 */
export function dismissSuggestion(suggestionId: string): DismissResult {
  const db = getDb()
  const row = db
    .query('SELECT review_status FROM autolink_suggestions WHERE id = ?')
    .get(suggestionId) as { review_status: string } | undefined
  if (!row) return { dismissed: false, reason: 'not_found' }
  if (row.review_status === 'dismissed') return { dismissed: false, reason: 'already_dismissed' }

  db.query(
    `UPDATE autolink_suggestions
     SET review_status='dismissed', reviewed_at=datetime('now')
     WHERE id=?`,
  ).run(suggestionId)
  return { dismissed: true }
}

// ───────────────────── List / Find ─────────────────────

function buildWhere(filter: ListFilter): { sql: string; params: unknown[] } {
  const conds: string[] = []
  const params: unknown[] = []
  if (filter.sourceBlockId) {
    conds.push('source_block_id = ?')
    params.push(filter.sourceBlockId)
  }
  if (filter.docId) {
    conds.push('source_block_id IN (SELECT id FROM blocks WHERE root_id = ?)')
    params.push(filter.docId)
  }
  if (filter.actionStatus) {
    const list = Array.isArray(filter.actionStatus) ? filter.actionStatus : [filter.actionStatus]
    if (list.length > 0) {
      conds.push(`action_status IN (${list.map(() => '?').join(',')})`)
      params.push(...list)
    }
  }
  if (filter.reviewStatus) {
    const list = Array.isArray(filter.reviewStatus) ? filter.reviewStatus : [filter.reviewStatus]
    if (list.length > 0) {
      conds.push(`review_status IN (${list.map(() => '?').join(',')})`)
      params.push(...list)
    }
  }
  return { sql: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params }
}

export function listSuggestions(filter: ListFilter = {}): AutoLinkSuggestion[] {
  const db = getDb()
  const limit = filter.limit ?? 200
  const order = filter.order === 'asc' ? 'ASC' : 'DESC'
  const { sql: where, params } = buildWhere(filter)
  const rows = db
    .query(
      `SELECT * FROM autolink_suggestions ${where}
       ORDER BY created_at ${order}
       LIMIT ?`,
    )
    .all(...[...params, limit] as Array<string | number>) as SuggestionRow[]
  return rows.map(rowToSuggestion)
}

/** 兼容旧 API：单 block 的活跃 suggestion（applied + suggested，排除 superseded / failed）*/
export function listSuggestionsForBlock(blockId: string): AutoLinkSuggestion[] {
  return listSuggestions({
    sourceBlockId: blockId,
    actionStatus: ['suggested', 'applied', 'reverted'],
    limit: 100,
  })
}

/** 兼容旧 API：某 doc 下所有 block 的活跃 suggestion */
export function listSuggestionsForDoc(_docId: string, blockIdsInDoc: string[]): AutoLinkSuggestion[] {
  if (blockIdsInDoc.length === 0) return []
  // 直接按 block_ids 查
  const db = getDb()
  const placeholders = blockIdsInDoc.map(() => '?').join(',')
  const rows = db
    .query(
      `SELECT * FROM autolink_suggestions
       WHERE source_block_id IN (${placeholders})
         AND action_status NOT IN ('superseded', 'failed')
       ORDER BY created_at DESC
       LIMIT 500`,
    )
    .all(...blockIdsInDoc) as SuggestionRow[]
  return rows.map(rowToSuggestion)
}

export function findSuggestion(id: string): AutoLinkSuggestion | undefined {
  const db = getDb()
  const row = db
    .query('SELECT * FROM autolink_suggestions WHERE id = ?')
    .get(id) as SuggestionRow | undefined
  return row ? rowToSuggestion(row) : undefined
}

/** 块删除时清理（FK CASCADE 已处理；这里保留作为兼容空操作） */
export function removeSuggestionsForBlock(blockId: string): void {
  // FK ON DELETE CASCADE 会自动删除；显式调用为 no-op（保留函数签名兼容）
  void blockId
}

// ───────────────────── Wire 序列化（给 API / MCP 用） ─────────────────────

export function toWire(s: AutoLinkSuggestion) {
  return {
    id: s.id,
    source_block_id: s.sourceBlockId,
    source_doc_id: null as string | null,    // 由调用方按需补
    source_content: null as string | null,   // 由调用方按需补
    anchor: s.anchor,
    kind: s.kind,
    candidates: s.candidates.map((c) => ({
      block_id: c.blockId,
      doc_id: c.docId,
      doc_title: c.docTitle,
      snippet: c.snippet,
      confidence: Math.round(c.confidence * 1000) / 1000,
      score_kind: c.scoreKind,
    })),
    action_status: s.actionStatus,
    review_status: s.reviewStatus,
    applied_target_id: s.appliedTargetId,
    created_ref_id: s.createdRefId,
    score_kind: s.scoreKind,
    error: s.error,
    created_at: s.createdAt,
    applied_at: s.appliedAt,
    reviewed_at: s.reviewedAt,
  }
}

// 兼容旧 import：clearAllSuggestions 不再需要（数据已落库），保留为 no-op
export function clearAllSuggestions(): void {
  // intentional no-op
}

// 兼容旧导出类型
export type { Citation } from './hybridSearch'

/** 测试钩子 */
export function _resetForTests(): void {
  const db = getDb()
  db.query('DELETE FROM autolink_suggestions').run()
}

void ({} as Database)
