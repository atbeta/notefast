/**
 * AutoLink 引擎（v4 —— 高置信直接建链，无人工审核）
 *
 * 流程：
 *   1) LLM 从块内容里抽出 mention 列表（严格 JSON；不抽工具/API/函数名）
 *   2) kind 过滤（excludeAnchorKinds，默认丢 tool）
 *   3) 每个 mention.anchor 去命中现有 block（hybrid search；excludeSelfDoc 排除同文档；
 *      ai_exclude / inbox / archived 文档不作候选）
 *   4) 建链门槛：top-1 必须语义命中（embedding/hybrid）且 ≥ minConfidence，
 *      且与 top-2 的分差 ≥ minMargin —— 满足即直接写 block_refs（ref_type='ai_auto'）
 *   5) 不满足即静默跳过（记入 skippedAnchors 便于排查）；没有任何中间状态与审核队列
 *
 * 评分语义（沿用 v3）：
 *   - FTS-only: confidence = 1 - rank/N，score_kind='fts_rank'，永远达不到建链门槛
 *   - hybrid: confidence = 纯 cosine（不再与 FTS rank 分取 max，杜绝伪高置信）
 *   - 候选缺向量：诚实地标回 'fts_rank'
 *
 * 并发与配额保护：
 *   - 同 block 的 analyzeBlock 请求串行化（inflight Map）
 *   - 全局滑动窗口限速（rateLimitPerMinute，burst 时超出直接跳过）
 *   - block 内容更新时由 aiRuntime 先清掉旧的 ai_auto 引用再重评（见 services/aiRuntime）
 */

import {
  DEFAULT_AUTO_LINK_EXCLUDE_KINDS,
  DEFAULT_AUTO_LINK_EXCLUDE_SELF_DOC,
  DEFAULT_AUTO_LINK_RATE_LIMIT_PER_MINUTE,
  type ChatMessage,
} from '@notefast/core'
import { getDb } from '../db'
import { getBlockById } from '../store/blocks'
import { findRefByPair, insertRef } from '../store/refs'
import { lexicalSearch } from '../lexicalSearch'
import { getRuntime, hasRuntime } from '../services/aiRuntime'
import { embeddingFingerprint, getVectorStore } from './vectorStore'
import {
  isBlockAiExcluded,
  loadAiExcludedDocIds,
  loadArchivedDocIds,
  loadInboxDocIds,
} from './aiExcludeQuery'

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

/** 一条已自动建立的链接 */
export interface AutoLinkAppliedLink {
  anchor: string
  targetBlockId: string
  targetDocId: string
  confidence: number
}

export interface AnalyzeResult {
  analyzed: number
  /** 本次直接建立的链接数 */
  applied: number
  /** 建立的链接明细（anchor → 目标块） */
  links: AutoLinkAppliedLink[]
  errors: string[]
  /** true = 命中全局限速，本次未执行抽取（不视为错误） */
  rateLimited?: boolean
  /** 抽到锚点但因低于 minConfidence / 非语义命中而未建链的数量 */
  skippedLowConfidence?: number
  /** 被门槛过滤的锚点摘要（最多 10 条，便于调用方理解「为何没有建链」） */
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

  const links: AutoLinkAppliedLink[] = []
  const errors: string[] = []
  const skippedAnchors: NonNullable<AnalyzeResult['skippedAnchors']> = []
  const db = getDb()

  // 读源 block 所属文档（root_id 用于自指过滤）
  const blockRow = getBlockById(db, opts.blockId)
  const excludeSelfDoc = cfg.excludeSelfDoc ?? DEFAULT_AUTO_LINK_EXCLUDE_SELF_DOC
  const sourceDocId = excludeSelfDoc ? (blockRow?.root_id ?? null) : null

  for (const m of mentions) {
    try {
      const ranked = await findCandidates(opts.blockId, m.anchor, opts.notebookId, opts.notebookScope, sourceDocId)
      if (ranked.length === 0) {
        if (skippedAnchors.length < 10) {
          skippedAnchors.push({ anchor: m.anchor, reason: 'no_candidates' })
        }
        continue
      }

      // 建链门槛：top-1 必须是语义命中（embedding/hybrid）且 ≥ minConfidence。
      // FTS-only 是纯字面匹配，不构成「链接」——宁缺毋滥。
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

      // 分差门槛：top1 必须明显领先 top2，避免「两个都差不多」的歧义建链
      const top2 = ranked[1]?.confidence ?? 0
      if (top1.confidence - top2 < cfg.minMargin) {
        if (skippedAnchors.length < 10) {
          skippedAnchors.push({ anchor: m.anchor, reason: 'low_margin', confidence: top1.confidence })
        }
        continue
      }

      // 已存在同 (source, target) 引用（任意类型）→ 不重复建链
      if (findRefByPair(db, opts.blockId, top1.blockId)) {
        if (skippedAnchors.length < 10) {
          skippedAnchors.push({ anchor: m.anchor, reason: 'already_linked', confidence: top1.confidence })
        }
        continue
      }

      insertRef(db, { sourceId: opts.blockId, targetId: top1.blockId, refType: 'ai_auto' })
      links.push({
        anchor: m.anchor,
        targetBlockId: top1.blockId,
        targetDocId: top1.docId,
        confidence: top1.confidence,
      })
    } catch (e) {
      errors.push(`${m.anchor}: ${e instanceof Error ? e.message : e}`)
    }
  }

  runtime.recordAutoLink(errors.length === 0, errors[0])
  const skippedLowConfidence = skippedAnchors.filter(
    (s) => s.reason === 'low_confidence' || s.reason === 'fts_only',
  ).length
  return {
    analyzed: 1,
    applied: links.length,
    links,
    errors,
    skippedLowConfidence,
    skippedAnchors: skippedAnchors.length > 0 ? skippedAnchors : undefined,
  }
}

function empty(): AnalyzeResult {
  return { analyzed: 0, applied: 0, links: [], errors: [] }
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
    // 推理模型（如 MiniMax-M3）的 reasoning 会吃掉大量 token 预算，400 容易截断 JSON
    maxTokens: 1500,
    responseFormat: { type: 'json_object' },
  })
  const parsed = safeParseMentions(raw, content)
  return parsed.slice(0, max)
}

function safeParseMentions(raw: string, sourceContent: string): Mention[] {
  const cleaned = raw
    // 防御：runtime 非流式 chat 已统一剥离 <think>，这里再兜一层（直调/provider 异常时）
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
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

type ScoreKind = 'fts_rank' | 'embedding' | 'hybrid'

interface Candidate {
  blockId: string
  docId: string
  docTitle: string
  snippet: string
  confidence: number
  scoreKind: ScoreKind
}

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

  const extraWhere: string[] = ['AND b.id != ?']
  const extraParams: (string | number)[] = [sourceBlockId]
  if (sourceDocId) {
    extraWhere.push('AND b.root_id != ?')
    extraParams.push(sourceDocId)
  }

  // 双路词法检索：LIKE 严格路覆盖 CJK 子串（原 try/catch LIKE 降级已上移到 lexicalSearch），
  // strictOnly 禁用 OR 降级保精度
  let rows = lexicalSearch(anchor, {
    notebookId: scope === 'same' ? notebookId : undefined,
    limit: 10,
    strictOnly: true,
    extraWhere,
    extraParams,
  }).map((h) => ({ id: h.id, content: h.content, root_id: h.root_id, doc_title: h.doc_title }))

  if (rows.length === 0) return []

  // 过滤 ai_exclude / inbox / archived 文档的候选（与检索默认过滤语义一致）
  const rootIds = rows.map((r) => r.root_id)
  const excluded = loadAiExcludedDocIds(rootIds)
  const inbox = loadInboxDocIds(rootIds)
  const archived = loadArchivedDocIds(rootIds)
  rows = rows.filter((r) => !excluded.has(r.root_id) && !inbox.has(r.root_id) && !archived.has(r.root_id))
  if (rows.length === 0) return []

  // FTS-only：rank 位置分（score_kind='fts_rank'，达不到建链门槛）
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
        // 没向量：无法给出语义分 → 诚实地标回 fts_rank（达不到建链门槛）
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

// ───────────────────── DB helpers ─────────────────────

/** 列出某 doc 下所有 block 的 id */
export function listBlockIdsForDoc(docId: string): string[] {
  const db = getDb()
  const rows = db.query('SELECT id FROM blocks WHERE root_id = ?').all(docId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}
