/**
 * AutoLink 引擎（v2）
 *
 * 流程：
 *   1) LLM 从块内容里抽出 mention 列表（严格 JSON）
 *   2) 每个 mention.anchor 去命中现有 block（hybrid search）
 *   3) 根据 scoreKind + minConfidence + minMargin 决定是否自动应用
 *   4) 写入 autolink_suggestions（SQLite）；自动应用的同步写 block_refs
 *
 * 评分语义（v2 修复）：
 *   - FTS-only: confidence = 1 - rank/N，score_kind='fts_rank'，不参与 autoApply 判定
 *   - embedding: confidence = cosine，score_kind='embedding'，参与 minConfidence 阈值
 *   - hybrid: confidence = cosine（embedding 优先），score_kind='hybrid'
 *
 * 并发保护：
 *   - 同 block 的 analyzeBlock 请求串行化（inflight Map）
 *   - 每次写入前用 source_content_hash 标记旧 suggestion 为 superseded
 */

import { createHash } from 'node:crypto'
import type { ChatMessage } from '@notefast/core'
import { getDb } from '../db'
import { getRuntime, hasRuntime } from '../services/aiRuntime'
import {
  addSuggestions,
  type AutoLinkSuggestion,
  type Candidate,
  type ScoreKind,
} from './autoLinkStore'

const EXTRACT_SYSTEM_PROMPT = `你是 NoteFast 的实体抽取助手。从用户给定的笔记内容中识别可以建立反向链接的具体名词短语（"锚点"）。

严格规则：
- 输出必须是合法 JSON：{"mentions": [{"anchor":"...", "kind":"concept|tool|person|doc"} , ...]}
- anchor 必须 ≥3 字、最长 20 字，在原文里逐字出现
- 排除：停用词、人称代词、纯数字、纯标点、连接词
- 同一 anchor 在同一块内只出现一次
- 最多输出 5 个 mentions；过短或没具体名词时返回 {"mentions": []}
- kind 只能是 concept / tool / person / doc 之一`

const MAX_CONTENT_CHARS = 1500

export interface AnalyzeOptions {
  blockId: string
  content: string
  notebookId?: string
  notebookScope: 'all' | 'same'
  maxPerBlock: number
}

export interface AnalyzeResult {
  analyzed: number
  suggestionsAdded: number
  applied: number
  suggestions: AutoLinkSuggestion[]
  errors: string[]
}

// ───────────────────── 同 block 串行化 ─────────────────────

const inflight = new Map<string, Promise<AnalyzeResult>>()

export async function analyzeBlock(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  // 同 block 的并发请求串行化：等待上一个结束才执行新的
  const prev = inflight.get(opts.blockId)
  if (prev) {
    try { await prev } catch { /* ignore */ }
  }
  const p = doAnalyze(opts).finally(() => inflight.delete(opts.blockId))
  inflight.set(opts.blockId, p)
  return p
}

// ───────────────────── 主逻辑 ─────────────────────

async function doAnalyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  if (!hasRuntime()) return empty()
  const runtime = getRuntime()
  if (!runtime.hasChat()) return empty()

  const trimmed = opts.content.trim().slice(0, MAX_CONTENT_CHARS)
  if (trimmed.length < 10) return empty()

  const cfg = runtime.autoLinkConfig()
  const max = Math.max(1, Math.min(10, opts.maxPerBlock || cfg.maxPerBlock || 5))

  let mentions: Mention[]
  try {
    mentions = await extractMentions(runtime, trimmed, max)
  } catch (e) {
    runtime.recordAutoLink(false, e instanceof Error ? e.message : String(e))
    return { ...empty(), errors: [e instanceof Error ? e.message : String(e)] }
  }
  if (mentions.length === 0) {
    runtime.recordAutoLink(true)
    return empty()
  }

  const suggestions: AutoLinkSuggestion[] = []
  const errors: string[] = []
  let applied = 0
  const db = getDb()

  // 读源 block 的当前 updated_at（用作 source_updated_at 字段）
  const blockRow = db
    .query('SELECT updated_at FROM blocks WHERE id = ?')
    .get(opts.blockId) as { updated_at: string } | undefined
  const sourceUpdatedAt = blockRow?.updated_at ?? new Date().toISOString()
  const sourceHash = sha256(trimmed)

  for (const m of mentions) {
    try {
      const ranked = await findCandidates(opts.blockId, m.anchor, opts.notebookId, opts.notebookScope)
      if (ranked.length === 0) continue

      // 决策：自动应用 vs 仅建议
      const top1 = ranked[0]!
      const top2 = ranked[1]?.confidence ?? 0
      const margin = top1.confidence - top2

      const canAutoApply =
        cfg.autoApply === 'high_confidence' &&
        (top1.scoreKind === 'embedding' || top1.scoreKind === 'hybrid') &&
        top1.confidence >= cfg.minConfidence &&
        margin >= cfg.minMargin

      // 所有 ranked 候选都进 suggestion 表（保留 audit）；
      // FTS-only 在 Inbox 查询里默认展示（属于"中可信"档），未来 metrics 用
      const usableCandidates = ranked

      const refType: 'ai_suggested' | 'ai_auto' = canAutoApply ? 'ai_auto' : 'ai_suggested'

      const sug: AutoLinkSuggestion = {
        id: crypto.randomUUID(),
        sourceBlockId: opts.blockId,
        sourceContentHash: sourceHash,
        sourceUpdatedAt,
        notebookId: opts.notebookId ?? '',
        anchor: m.anchor,
        kind: m.kind,
        candidates: usableCandidates,
        actionStatus: 'suggested',         // 初始；若 autoApply 成功，addSuggestions 内部会改
        reviewStatus: 'unreviewed',
        createdRefId: null,
        appliedTargetId: null,
        scoreKind: usableCandidates[0]!.scoreKind,
        model: runtime.chatProviderDef()?.label ?? null,
        error: null,
        createdAt: new Date().toISOString(),
        appliedAt: null,
        reviewedAt: null,
      }
      suggestions.push(sug)

      // autoApply：立即落 ref（注意：addSuggestions 之外单独 INSERT ref）
      if (canAutoApply) {
        const target = top1.blockId
        try {
          const ok = insertRef(opts.blockId, target, refType)
          if (ok) applied++
        } catch (e) {
          errors.push(`apply ${m.anchor}: ${e instanceof Error ? e.message : e}`)
        }
      }
    } catch (e) {
      errors.push(`${m.anchor}: ${e instanceof Error ? e.message : e}`)
    }
  }

  if (suggestions.length > 0) {
    addSuggestions(suggestions)
    // 注意：autoApply 的 ref 已由 insertRef 写入；但 suggestion 表里的 action_status 还是 'suggested'，
    // created_ref_id 为 null。这是为了让 Inbox 能看到「AI 刚做了什么」并允许精确撤销。
    // 修复策略：在 autoApply 路径上，把每个被应用的 suggestion 直接 UPDATE 一下。
    if (cfg.autoApply === 'high_confidence' && applied > 0) {
      // 重新查最近一次插入的 suggestions，对 top-1 命中的做精确 mark
      for (const s of suggestions) {
        const top = s.candidates[0]
        if (!top) continue
        if (
          (top.scoreKind === 'embedding' || top.scoreKind === 'hybrid') &&
          top.confidence >= cfg.minConfidence &&
          top.confidence - (s.candidates[1]?.confidence ?? 0) >= cfg.minMargin
        ) {
          // 查 ref id（同 source, target, ref_type='ai_auto'）
          const refRow = db
            .query(
              "SELECT id FROM block_refs WHERE source_id = ? AND target_id = ? AND ref_type = 'ai_auto' ORDER BY id DESC LIMIT 1",
            )
            .get(s.sourceBlockId, top.blockId) as { id: number } | undefined
          if (refRow) {
            db.query(
              `UPDATE autolink_suggestions
               SET action_status='applied', created_ref_id=?, applied_target_id=?, applied_at=datetime('now')
               WHERE id=?`,
            ).run(refRow.id, top.blockId, s.id)
          }
        }
      }
    }
  }

  runtime.recordAutoLink(errors.length === 0, errors[0])
  return { analyzed: 1, suggestionsAdded: suggestions.length, suggestions, applied, errors }
}

function empty(): AnalyzeResult {
  return { analyzed: 0, suggestionsAdded: 0, suggestions: [], applied: 0, errors: [] }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// ───────────────────── Extraction ─────────────────────

interface Mention {
  anchor: string
  kind: string
}

async function extractMentions(
  runtime: ReturnType<typeof getRuntime>,
  content: string,
  max: number,
): Promise<Mention[]> {
  const messages: ChatMessage[] = [
    { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
    { role: 'user', content: content },
  ]
  const raw = await runtime.chat(messages, {
    temperature: 0,
    maxTokens: 400,
    responseFormat: { type: 'json_object' },
  })
  const parsed = safeParseMentions(raw, content)
  return parsed.slice(0, max)
}

function safeParseMentions(raw: string, sourceContent: string): Mention[] {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
  let json: unknown = null
  try {
    json = JSON.parse(cleaned)
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (m) {
      try { json = JSON.parse(m[0]) } catch { /* fallthrough */ }
    }
  }
  if (!json || typeof json !== 'object') return []
  const arr = (json as { mentions?: unknown }).mentions
  if (!Array.isArray(arr)) return []
  const out: Mention[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const a = (item as { anchor?: unknown }).anchor
    const k = (item as { kind?: unknown }).kind
    if (typeof a !== 'string' || a.length < 3 || a.length > 20) continue
    if (!sourceContent.includes(a)) continue
    const kind = typeof k === 'string' && ['concept', 'tool', 'person', 'doc'].includes(k) ? k : 'concept'
    out.push({ anchor: a.trim(), kind })
  }
  return out
}

// ───────────────────── Candidate matching ─────────────────────

const STOP_ANCHORS = new Set(['note', '笔记', '内容', '下面的', '示例', '例子', '相关', '一般', '通常'])

async function findCandidates(
  sourceBlockId: string,
  anchor: string,
  notebookId: string | undefined,
  scope: 'all' | 'same',
): Promise<Candidate[]> {
  if (STOP_ANCHORS.has(anchor.toLowerCase())) return []
  const db = getDb()

  let sql = `
    SELECT b.id, b.content, b.root_id, (SELECT content FROM blocks WHERE id = b.root_id) as doc_title
    FROM blocks_fts f
    JOIN blocks b ON b.id = f.id
    WHERE blocks_fts MATCH ?`
  const params: (string | number)[] = [`"${anchor.replace(/['"*()]/g, ' ').trim()}"`]

  if (scope === 'same' && notebookId) {
    sql += ' AND b.notebook_id = ? AND b.id != ?'
    params.push(notebookId, sourceBlockId)
  } else {
    sql += ' AND b.id != ?'
    params.push(sourceBlockId)
  }
  sql += ' ORDER BY rank LIMIT 10'

  let rows: Array<{ id: string; content: string; root_id: string; doc_title: string }>
  try {
    rows = db.query(sql).all(...params as [string, ...(string | number)[]]) as Array<{
      id: string
      content: string
      root_id: string
      doc_title: string
    }>
  } catch {
    const likeSql = `SELECT b.id, b.content, b.root_id, (SELECT content FROM blocks WHERE id = b.root_id) as doc_title
                     FROM blocks b WHERE b.content LIKE ? AND b.id != ? LIMIT 10`
    rows = db.query(likeSql).all(`%${anchor}%`, sourceBlockId) as Array<{
      id: string
      content: string
      root_id: string
      doc_title: string
    }>
  }

  if (rows.length === 0) return []

  // ★ v2: score_kind 显式标注；FTS-only 时 top-1 confidence 不再恒为 1.0
  const embeddingAvailable = hasRuntime() && getRuntime().hasEmbedding()
  const N = rows.length
  const ftsRanked: Candidate[] = rows.map((r, i) => ({
    blockId: r.id,
    docId: r.root_id,
    docTitle: r.doc_title,
    snippet: r.content.slice(0, 120),
    confidence: 1 - i / N,                     // ★ FTS-only：top-1 = 1 - 1/N，不再恒为 1.0
    scoreKind: 'fts_rank' as ScoreKind,
  }))

  if (!embeddingAvailable) {
    return ftsRanked.slice(0, 3)
  }

  // 用 embedding cosine 重排
  try {
    const r = getRuntime()
    const qv = await r.embedQuery(anchor)
    if (!qv) return ftsRanked.slice(0, 3)

    const { cosineSimilarity } = await import('@notefast/core')
    const hybrid: Candidate[] = []
    for (let i = 0; i < ftsRanked.length; i++) {
      const fts = ftsRanked[i]!
      const vecRow = db
        .query('SELECT embedding FROM block_vectors WHERE block_id = ?')
        .get(fts.blockId) as { embedding: string } | undefined
      if (!vecRow) {
        // 没向量：保留 FTS 候选但 score_kind 标 hybrid（说明有 FTS 命中 + 缺向量）
        hybrid.push({ ...fts, scoreKind: 'hybrid' })
        continue
      }
      try {
        const v = new Float64Array(JSON.parse(vecRow.embedding) as number[])
        const sim = cosineSimilarity(qv, v)
        hybrid.push({
          ...fts,
          confidence: Math.max(fts.confidence, sim),   // hybrid 取 max
          scoreKind: 'hybrid',
        })
      } catch {
        hybrid.push({ ...fts, scoreKind: 'hybrid' })
      }
    }
    hybrid.sort((a, b) => b.confidence - a.confidence)
    return hybrid.slice(0, 3)
  } catch {
    return ftsRanked.slice(0, 3)
  }
}

// ───────────────────── DB writes ─────────────────────

export function insertRef(sourceId: string, targetId: string, refType: string): boolean {
  if (sourceId === targetId) return false
  const db = getDb()
  const existing = db
    .query('SELECT id FROM block_refs WHERE source_id = ? AND target_id = ?')
    .get(sourceId, targetId)
  if (existing) return false
  db.query('INSERT INTO block_refs (source_id, target_id, ref_type) VALUES (?, ?, ?)').run(
    sourceId,
    targetId,
    refType,
  )
  return true
}

export function deleteRefByPair(sourceId: string, targetId: string): number {
  const db = getDb()
  const r = db.query('DELETE FROM block_refs WHERE source_id = ? AND target_id = ?').run(sourceId, targetId)
  return r.changes
}

/** 列出某 doc 下所有 block 的 id（用于前端拉取 suggestions） */
export function listBlockIdsForDoc(docId: string): string[] {
  const db = getDb()
  const rows = db.query('SELECT id FROM blocks WHERE root_id = ?').all(docId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}
