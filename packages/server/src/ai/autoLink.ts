/**
 * AutoLink 引擎（v3 —— 精准优先）
 *
 * 流程：
 *   1) LLM 从块内容里抽出 mention 列表（严格 JSON；不抽工具/API/函数名）
 *   2) kind 过滤（excludeAnchorKinds，默认丢 tool）
 *   3) 每个 mention.anchor 去命中现有 block（hybrid search；excludeSelfDoc 排除同文档）
 *   4) 建议入库门槛：top-1 必须 embedding/hybrid 且 ≥ minConfidence —— FTS-only 不进 Inbox
 *   5) 满足 minMargin 的进一步 autoApply 写 block_refs
 *
 * 评分语义（v3）：
 *   - FTS-only: confidence = 1 - rank/N，score_kind='fts_rank'，永远达不到入库门槛
 *   - hybrid: confidence = 纯 cosine（不再与 FTS rank 分取 max，杜绝伪高置信）
 *   - 候选缺向量：诚实地标回 'fts_rank'
 *
 * 并发与配额保护：
 *   - 同 block 的 analyzeBlock 请求串行化（inflight Map）
 *   - 全局滑动窗口限速（rateLimitPerMinute，burst 时超出直接跳过）
 *   - 每次写入前用 source_content_hash 标记旧 suggestion 为 superseded
 */

import { createHash } from 'node:crypto'
import {
  DEFAULT_AUTO_LINK_EXCLUDE_KINDS,
  DEFAULT_AUTO_LINK_EXCLUDE_SELF_DOC,
  DEFAULT_AUTO_LINK_RATE_LIMIT_PER_MINUTE,
  type ChatMessage,
} from '@notefast/core'
import { getDb } from '../db'
import { getRuntime, hasRuntime } from '../services/aiRuntime'
import { embeddingFingerprint, getVectorStore } from './vectorStore'
import {
  addSuggestions,
  type AutoLinkSuggestion,
  type Candidate,
  type ScoreKind,
} from './autoLinkStore'

const EXTRACT_SYSTEM_PROMPT = `你是 NoteFast 的实体抽取助手。从用户给定的笔记内容中识别可以建立反向链接的具体名词短语（"锚点"）。

严格规则：
- 输出必须是合法 JSON：{"mentions": [{"anchor":"...", "kind":"concept|person|doc"} , ...]}
- anchor 必须 ≥3 字、最长 20 字，在原文里逐字出现
- 排除：停用词、人称代词、纯数字、纯标点、连接词
- 排除：工具名、API 名、函数名、命令行、代码标识符（如 snake_case / camelCase / 带前缀的名称）——提及工具不等于需要链接
- 同一 anchor 在同一块内只出现一次
- 最多输出 3 个 mentions；过短或没具体名词时返回 {"mentions": []}
- 拿不准就不要输出：锚点贵精不贵多
- kind 只能是 concept / person / doc 之一`

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
  /** true = 命中全局限速，本次未执行抽取（不视为错误） */
  rateLimited?: boolean
  /** 抽到锚点但因低于 minConfidence / 非语义命中而未入库的数量 */
  skippedLowConfidence?: number
  /** 被门槛过滤的锚点摘要（最多 10 条，便于调用方理解「为何 Inbox 为空」） */
  skippedAnchors?: Array<{ anchor: string; reason: string; confidence?: number }>
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

// ───────────────────── 全局限速（滑动窗口计数）─────────────────────
// 批量导入/连续保存时每个 block 都会触发一次分析；超过 rateLimitPerMinute
// 的直接跳过（不排队、不报错），保护 chat provider 配额。

const RATE_WINDOW_MS = 60_000
let rateWindowStart = 0
let rateWindowCount = 0

function hitRateLimit(perMinute: number): boolean {
  if (perMinute <= 0) return false // 0 = 不限速
  const now = Date.now()
  if (now - rateWindowStart >= RATE_WINDOW_MS) {
    rateWindowStart = now
    rateWindowCount = 0
  }
  if (rateWindowCount >= perMinute) return true
  rateWindowCount++
  return false
}

/** 测试专用：重置限速窗口，避免跨用例互相影响 */
export function _resetRateLimitForTests(): void {
  rateWindowStart = 0
  rateWindowCount = 0
}

// ───────────────────── 主逻辑 ─────────────────────

async function doAnalyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  if (!hasRuntime()) return empty()
  const runtime = getRuntime()
  if (!runtime.hasChat()) return empty()

  // AI 软隔离：排除文档不分析、不送 LLM
  const { isBlockAiExcluded } = await import('./aiExclude')
  if (isBlockAiExcluded(opts.blockId)) return empty()

  const trimmed = opts.content.trim().slice(0, MAX_CONTENT_CHARS)
  if (trimmed.length < 10) return empty()

  const cfg = runtime.autoLinkConfig()

  // 全局限速：burst 时超出的直接跳过（不排队、不算错误）
  if (hitRateLimit(cfg.rateLimitPerMinute ?? DEFAULT_AUTO_LINK_RATE_LIMIT_PER_MINUTE)) {
    return { ...empty(), rateLimited: true }
  }

  const max = Math.max(1, Math.min(10, opts.maxPerBlock || cfg.maxPerBlock || 2))

  let mentions: Mention[]
  try {
    mentions = await extractMentions(runtime, trimmed, max)
  } catch (e) {
    runtime.recordAutoLink(false, e instanceof Error ? e.message : String(e))
    return { ...empty(), errors: [e instanceof Error ? e.message : String(e)] }
  }

  // kind 过滤：默认丢弃 tool 类锚点（工具名 → 工具描述是同义反复，不构成有效链接）
  const excludedKinds = new Set((cfg.excludeAnchorKinds ?? DEFAULT_AUTO_LINK_EXCLUDE_KINDS).map((k) => k.toLowerCase()))
  if (excludedKinds.size > 0) {
    mentions = mentions.filter((m) => !excludedKinds.has(m.kind.toLowerCase()))
  }

  if (mentions.length === 0) {
    runtime.recordAutoLink(true)
    return empty()
  }

  const suggestions: AutoLinkSuggestion[] = []
  const errors: string[] = []
  const skippedAnchors: NonNullable<AnalyzeResult['skippedAnchors']> = []
  let applied = 0
  const db = getDb()

  // 读源 block 的 updated_at 与所属文档（root_id 用于自指过滤）
  const blockRow = db
    .query('SELECT updated_at, root_id FROM blocks WHERE id = ?')
    .get(opts.blockId) as { updated_at: string; root_id: string } | undefined
  const sourceUpdatedAt = blockRow?.updated_at ?? new Date().toISOString()
  const excludeSelfDoc = cfg.excludeSelfDoc ?? DEFAULT_AUTO_LINK_EXCLUDE_SELF_DOC
  const sourceDocId = excludeSelfDoc ? (blockRow?.root_id ?? null) : null
  const sourceHash = sha256(trimmed)

  for (const m of mentions) {
    try {
      const ranked = await findCandidates(opts.blockId, m.anchor, opts.notebookId, opts.notebookScope, sourceDocId)
      if (ranked.length === 0) {
        if (skippedAnchors.length < 10) {
          skippedAnchors.push({ anchor: m.anchor, reason: 'no_candidates' })
        }
        continue
      }

      // 建议入库门槛（v3）：top-1 必须是语义命中（embedding/hybrid）且 ≥ minConfidence。
      // FTS-only 是纯字面匹配，不构成「建议」——宁缺毋滥，避免 Inbox 噪音洪水。
      const top1 = ranked[0]!
      const isSemantic = top1.scoreKind === 'embedding' || top1.scoreKind === 'hybrid'
      if (!isSemantic || top1.confidence < cfg.minConfidence) {
        if (skippedAnchors.length < 10) {
          skippedAnchors.push({
            anchor: m.anchor,
            reason: !isSemantic ? 'fts_only' : 'low_confidence',
            confidence: top1.confidence,
          })
        }
        continue
      }

      // 决策：自动应用 vs 仅建议（在入库门槛之上再要求 top1/top2 margin）
      const top2 = ranked[1]?.confidence ?? 0
      const margin = top1.confidence - top2

      const canAutoApply =
        cfg.autoApply === 'high_confidence' &&
        isSemantic &&
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
    // 注意：autoApply 的 ref 已由 insertRef 写入；但 suggestion 表里的 action_status 还是 'suggested'。
    // 修复策略：在 autoApply 路径上，把每个被应用的 suggestion 标为 applied + accepted。
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
               SET action_status='applied', review_status='accepted',
                   created_ref_id=?, applied_target_id=?,
                   applied_at=datetime('now'), reviewed_at=datetime('now')
               WHERE id=?`,
            ).run(refRow.id, top.blockId, s.id)
          }
        }
      }
    }
  }

  runtime.recordAutoLink(errors.length === 0, errors[0])
  const skippedLowConfidence = skippedAnchors.filter(
    (s) => s.reason === 'low_confidence' || s.reason === 'fts_only',
  ).length
  return {
    analyzed: 1,
    suggestionsAdded: suggestions.length,
    suggestions,
    applied,
    errors,
    skippedLowConfidence,
    skippedAnchors: skippedAnchors.length > 0 ? skippedAnchors : undefined,
  }
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
  /** 非 null 时排除该文档内的 block（自指过滤） */
  sourceDocId: string | null,
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
  if (sourceDocId) {
    sql += ' AND b.root_id != ?'
    params.push(sourceDocId)
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
    if (sourceDocId) rows = rows.filter((r) => r.root_id !== sourceDocId)
  }

  if (rows.length === 0) return []

  // 过滤 ai_exclude 文档的候选
  const { loadAiExcludedDocIds } = await import('./aiExclude')
  const excluded = loadAiExcludedDocIds(rows.map((r) => r.root_id))
  rows = rows.filter((r) => !excluded.has(r.root_id))
  if (rows.length === 0) return []

  // FTS-only：rank 位置分（仅用于展示排序；score_kind='fts_rank'，达不到建议入库门槛）
  const embeddingAvailable = hasRuntime() && getRuntime().hasEmbedding()
  const N = rows.length
  const ftsRanked: Candidate[] = rows.map((r, i) => ({
    blockId: r.id,
    docId: r.root_id,
    docTitle: r.doc_title,
    snippet: r.content.slice(0, 120),
    confidence: 1 - i / N,
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

    const provider = r.embeddingProviderDef()
    if (!provider) return ftsRanked.slice(0, 3)
    const scores = await getVectorStore().scoreCandidates(
      qv,
      ftsRanked.map((candidate) => candidate.blockId),
      embeddingFingerprint(provider),
    )
    const hybrid: Candidate[] = []
    for (let i = 0; i < ftsRanked.length; i++) {
      const fts = ftsRanked[i]!
      const score = scores.get(fts.blockId)
      if (score === undefined) {
        // 没向量：无法给出语义分 → 诚实地标回 fts_rank（不会达到建议入库门槛）
        hybrid.push({ ...fts, scoreKind: 'fts_rank' })
        continue
      }
      hybrid.push({
        ...fts,
        confidence: score,   // ★ v3：纯 cosine，不再与 FTS rank 分取 max（避免伪高置信）
        scoreKind: 'hybrid',
      })
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
