/**
 * AutoLink 引擎 —— 写入时实体理解引擎（高置信直接建链，无人工审核）
 *
 * 一次 LLM 抽取，mentions 同时喂两条消费线：
 *   1) 实体登记（ai/entities.registerMentions）：不过滤 kind，全量 → entities + entity_mentions
 *   2) 建链：kind 过滤（excludeAnchorKinds，默认丢 tool）+ 候选命中（hybrid search；
 *      excludeSelfDoc 排除同文档；ai_exclude / inbox / archived 文档不作候选）
 *      → 建链门槛：top-1 必须语义命中（embedding/hybrid）且 ≥ minConfidence，
 *      且与 top-2 的分差 ≥ minMargin —— 满足即直接写 block_refs（ref_type='ai_auto'）
 *   3) 不满足即静默跳过（记入 skippedAnchors 便于排查）；没有任何中间状态与审核队列
 *
 * 评分语义（沿用 v3）：
 *   - FTS-only: confidence = 1 - rank/N，score_kind='fts_rank'，永远达不到建链门槛
 *   - hybrid: confidence = 纯 cosine（不再与 FTS rank 分取 max，杜绝伪高置信）
 *   - 候选缺向量：诚实地标回 'fts_rank'
 *
 * 并发与配额保护：
 *   - 同 block 的 analyzeBlock 请求串行化（inflight Map）
 *   - 全局滑动窗口限速（rateLimitPerMinute，burst 时超出直接跳过）
 *   - block 内容更新时重评（replaceExisting）：限速未命中后先清掉旧的 ai_auto 引用/提及再重建，
 *     限速命中时保留旧链（见 doAnalyze 与 services/aiRuntime 的 afterUpdate hook）
 */

import {
  DEFAULT_AUTO_LINK_EXCLUDE_KINDS,
  DEFAULT_AUTO_LINK_EXCLUDE_SELF_DOC,
  DEFAULT_AUTO_LINK_RATE_LIMIT_PER_MINUTE,
  type ChatMessage,
} from '@notefast/core'
import { getDb } from '../db'
import { getBlockById, getLiveBlockById, fetchDocBlocks } from '../store/blocks'
import { findRefByPair, insertRef, deleteRefsFromSource } from '../store/refs'
import { lexicalSearch } from '../lexicalSearch'
import { getRuntime, hasRuntime } from '../services/aiRuntime'
import { registerMentions } from './entities'
import { deleteMentionsFromSource } from '../store/entities'
import { embeddingFingerprint, getVectorStore } from './vectorStore'
import {
  isBlockAiExcluded,
  loadAiExcludedDocIds,
  loadArchivedDocIds,
  loadInboxDocIds,
} from './aiExcludeQuery'

const EXTRACT_SYSTEM_PROMPT = `你是 NoteFast 的实体抽取助手。从用户给定的笔记内容中识别关键实体（概念 / 人物 / 工具 / 项目）作为名词短语（"锚点"）。

严格规则：
- 输出必须是合法 JSON：{"mentions": [{"anchor":"...", "kind":"concept|person|tool|doc"} , ...]}
- anchor 必须 ≥3 字、最长 20 字，在原文里逐字出现
- 排除：停用词、人称代词、纯数字、纯标点、连接词
- 排除代码标识符：含 _ 或 . 的符号名（变量 / 字段 / 函数 / 表名 / API 名），如 block_refs、mention_count、fs.readFile——它们是实现细节，不是知识实体
- 排除泛化短语：评价性 / 修饰性短语（如 高置信、零人工审核、硬指标）与过于宽泛的通用词（如 知识库、文档、笔记）
- 工具 / 项目 / 产品名也要抽取（kind=tool）——它们是知识图谱中的一等实体；独立的版本号后缀只保留主名（CodeMirror 6 → CodeMirror），名称本身含数字的除外（FTS5、BM25）
- 同一 anchor 在同一块内只出现一次
- 最多输出 5 个 mentions；过短或没具体名词时返回 {"mentions": []}
- 拿不准就不要输出：锚点贵精不贵多
- kind 只能是 concept / person / tool / doc 之一`

const MAX_CONTENT_CHARS = 1500

/**
 * 批量抽取 prompt（实体重建用）：一次 LLM 调用处理多个块。
 * 输入是 JSON 数组 [{block_id, content}]，输出按块归属的 mentions；
 * 单块规则与 EXTRACT_SYSTEM_PROMPT 一致（≥3 字、逐字出现、排除代码标识符等）。
 */
const EXTRACT_BATCH_SYSTEM_PROMPT = `你是 NoteFast 的实体抽取助手。用户会给你一个 JSON 数组，每项是一段笔记内容（block_id + content），你需要为每一段识别关键实体（概念 / 人物 / 工具 / 项目）作为名词短语（"锚点"）。

严格规则：
- 输出必须是合法 JSON：{"blocks": [{"block_id":"...", "mentions":[{"anchor":"...", "kind":"concept|person|tool|doc"} , ...]} , ...]}
- 必须为输入里的每一段都输出一个 blocks 项（block_id 原样返回）；某段没有实体时 mentions 为 []
- anchor 必须 ≥3 字、最长 20 字，在对应 content 里逐字出现
- 排除：停用词、人称代词、纯数字、纯标点、连接词
- 排除代码标识符：含 _ 或 . 的符号名（变量 / 字段 / 函数 / 表名 / API 名），如 block_refs、mention_count、fs.readFile——它们是实现细节，不是知识实体
- 排除泛化短语：评价性 / 修饰性短语（如 高置信、零人工审核、硬指标）与过于宽泛的通用词（如 知识库、文档、笔记）
- 工具 / 项目 / 产品名也要抽取（kind=tool）——它们是知识图谱中的一等实体；独立的版本号后缀只保留主名（CodeMirror 6 → CodeMirror），名称本身含数字的除外（FTS5、BM25）
- 同一 anchor 在同一段内只出现一次
- 每段最多输出 5 个 mentions；过短或没具体名词时返回 []
- 拿不准就不要输出：锚点贵精不贵多
- kind 只能是 concept / person / tool / doc 之一`

/** 单次批量抽取的输入字符预算（≈ 1.5-2k token，安全）；与块数解耦——短块多的文档一次吃下 */
const BATCH_MAX_CHARS = 6000
/** 硬上限：防单片输出 JSON 爆炸（每块最多 5 mentions） */
const BATCH_MAX_BLOCKS = 32

export interface AnalyzeOptions {
  blockId: string
  content: string
  maxPerBlock: number
  /** true = 只登记实体不建链（文档根块：标题是强实体信号，但不作链接源） */
  entitiesOnly?: boolean
  /** true = 绕过全局限速（用户显式触发的全量重建用；单次导入/保存仍限速） */
  skipRateLimit?: boolean
  /**
   * true = 内容更新重评：限速未命中后先清理该块旧的 ai_auto 引用与实体提及，再按新内容重建。
   * 清理必须在限速判定之后——先清再抽时若命中限速直接返回，旧链被清且不重建（丢链）。
   */
  replaceExisting?: boolean
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
  /** 本次登记的不同实体数（实体不过 kind 过滤，全量登记） */
  entities: number
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
  // 同 block 严格串行（promise 链）：本次执行挂在上一个登记的 promise 之后。
  // 旧实现「先 await prev 再登记」在 3+ 并发时会互相覆盖登记、并发执行 doAnalyze，
  // 且先结束者的 finally 会误删后继的登记。
  const prev = inflight.get(opts.blockId)
  const p = (prev ?? Promise.resolve())
    .catch(() => { /* 前序失败不影响后续执行 */ })
    .then(() => doAnalyze(opts))
  inflight.set(opts.blockId, p)
  // 清理时只删自己登记的那条（引用比较）——后继可能已覆盖登记，误删会破坏串行链
  const cleanup = () => {
    if (inflight.get(opts.blockId) === p) inflight.delete(opts.blockId)
  }
  void p.then(cleanup, cleanup)
  return p
}

export interface BatchAnalyzeOptions {
  /** 参与分析的块（content 已截断由内部处理）；entitiesOnly 按块传 */
  blocks: Array<Pick<AnalyzeOptions, 'blockId' | 'content' | 'entitiesOnly'>>
  /** 同 AnalyzeOptions.skipRateLimit：显式重建绕过限速 */
  skipRateLimit?: boolean
  /** 每片处理完后回调（done=已处理块数, total=总块数, errors=累计错误数）——供进度展示 */
  onProgress?: (done: number, total: number, errors: number) => void
}

export interface BatchAnalyzeResult {
  analyzed: number
  entities: number
  applied: number
  errors: string[]
  rateLimited: boolean
}

/**
 * 批量分析（实体重建用）：按「字符预算 + 块数硬上限」分片，每片一次 LLM 抽取，
 * 再逐块本地登记 + 建链。调用次数从「块数」降到「总字符 ÷ 预算」——
 * 短块多的文档（如 137 块/篇）一次调用吃下，长块自然多片。
 * 注意：无全局限速语义（skipRateLimit 由调用方决定；本函数内部不再 hitRateLimit）。
 */
export async function analyzeBlockBatch(opts: BatchAnalyzeOptions): Promise<BatchAnalyzeResult> {
  if (!hasRuntime() || !getRuntime().hasChat()) {
    throw new Error('Chat 模型未配置')
  }
  const runtime = getRuntime()
  const max = Math.max(1, Math.min(10, runtime.autoLinkConfig().maxPerBlock || 2))

  const result: BatchAnalyzeResult = { analyzed: 0, entities: 0, applied: 0, errors: [], rateLimited: false }

  // 预过滤：AI 排除 / 软删 / 长度不足的块不进 LLM（与单块 doAnalyze 一致）
  const eligible: Array<Pick<AnalyzeOptions, 'blockId' | 'content' | 'entitiesOnly'>> = []
  for (const b of opts.blocks) {
    if (isBlockAiExcluded(b.blockId)) continue
    if (!getLiveBlockById(getDb(), b.blockId)) continue
    const trimmed = (b.content ?? '').trim().slice(0, MAX_CONTENT_CHARS)
    if (trimmed.length < (b.entitiesOnly ? 3 : 10)) continue
    eligible.push({ blockId: b.blockId, content: trimmed, entitiesOnly: b.entitiesOnly })
  }
  if (eligible.length === 0) return result

  // 分片：贪心累积字符，超过 BATCH_MAX_CHARS 或 BATCH_MAX_BLOCKS 就开新片
  const slices: Array<Array<Pick<AnalyzeOptions, 'blockId' | 'content' | 'entitiesOnly'>>> = []
  let cur: Array<Pick<AnalyzeOptions, 'blockId' | 'content' | 'entitiesOnly'>> = []
  let curChars = 0
  for (const b of eligible) {
    const cost = b.content.length
    if (cur.length > 0 && (cur.length >= BATCH_MAX_BLOCKS || curChars + cost > BATCH_MAX_CHARS)) {
      slices.push(cur)
      cur = []
      curChars = 0
    }
    cur.push(b)
    curChars += cost
  }
  if (cur.length > 0) slices.push(cur)

  let sliceDone = 0
  for (const slice of slices) {
    let mentionsByBlock: Map<string, Mention[]>
    try {
      mentionsByBlock = await extractMentionsBatch(runtime, slice.map((b) => ({ blockId: b.blockId, content: b.content })))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      runtime.recordAutoLink(false, msg)
      result.errors.push(msg)
      sliceDone += slice.length
      opts.onProgress?.(Math.min(sliceDone, eligible.length), eligible.length, result.errors.length)
      // 抽取失败只丢这一片，继续后续片（与单块逐块 try/catch 语义一致）
      continue
    }
    for (const b of slice) {
      const mentions = mentionsByBlock.get(b.blockId) ?? []
      const r = await applyMentionsToBlock({ blockId: b.blockId, content: b.content, maxPerBlock: max, entitiesOnly: b.entitiesOnly }, mentions)
      result.analyzed += r.analyzed
      result.entities += r.entities
      result.applied += r.applied
      if (r.errors.length > 0) result.errors.push(...r.errors)
    }
    sliceDone += slice.length
    opts.onProgress?.(Math.min(sliceDone, eligible.length), eligible.length, result.errors.length)
  }
  return result
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

  // 软删防护：块已被删除（整篇替换在抽取完成前发生）不再分析——
  // 避免把 mentions / ai_auto refs 落在软删块上成为幽灵数据（见 registerMentions）
  if (!getLiveBlockById(getDb(), opts.blockId)) return empty()

  const trimmed = opts.content.trim().slice(0, MAX_CONTENT_CHARS)
  // 文档根（标题）只登记实体：标题短，下限放宽到 3 字（抽取层 anchor 本身 ≥3 字）
  if (trimmed.length < (opts.entitiesOnly ? 3 : 10)) return empty()

  const cfg = runtime.autoLinkConfig()

  // 全局限速：burst 时超出的直接跳过（不排队、不算错误）。
  // 显式重建（skipRateLimit）不受此限制——重建是用户主动触发的全量操作，
  // 限速会把它拖到「大部分块被跳过、实体为空」；单次导入/保存仍走限速。
  if (!opts.skipRateLimit && hitRateLimit(cfg.rateLimitPerMinute ?? DEFAULT_AUTO_LINK_RATE_LIMIT_PER_MINUTE)) {
    return { ...empty(), rateLimited: true }
  }

  // 内容更新重评：清理该块发出的旧 ai_auto 引用与实体提及，随后按新内容重建。
  // 位置必须在限速判定之后——限速命中时保留旧链，不清了不重建。
  if (opts.replaceExisting) {
    deleteRefsFromSource(getDb(), opts.blockId, 'ai_auto')
    deleteMentionsFromSource(getDb(), opts.blockId)
  }

  let mentions: Mention[]
  try {
    mentions = await extractMentions(runtime, trimmed)
  } catch (e) {
    runtime.recordAutoLink(false, e instanceof Error ? e.message : String(e))
    return { ...empty(), errors: [e instanceof Error ? e.message : String(e)] }
  }

  return applyMentionsToBlock(opts, mentions)
}

/**
 * 把已抽取的 mentions 落到库：实体登记 + 建链（与抽取解耦，供单块/批量共用）。
 * - 实体登记：不过滤 kind、不受 maxPerBlock 限制，全量登记
 * - 建链：kind 过滤 + maxPerBlock + 语义/分差门槛，本地 embedding 检索（不耗 LLM）
 */
async function applyMentionsToBlock(opts: AnalyzeOptions, mentions: Mention[]): Promise<AnalyzeResult> {
  const runtime = getRuntime()
  // 实体登记：一次抽取的第二条消费线——不过滤 kind、不受 maxPerBlock 限制，全量登记
  const entities = registerMentions(opts.blockId, mentions)

  // 文档根块（标题）：只登记实体不建链
  if (opts.entitiesOnly) {
    runtime.recordAutoLink(true)
    return { ...empty(), analyzed: 1, entities }
  }

  const cfg = runtime.autoLinkConfig()

  // kind 过滤只作用于建链：默认丢弃 tool 类锚点（工具名 → 工具描述是同义反复，不构成有效链接）
  const excludedKinds = new Set((cfg.excludeAnchorKinds ?? DEFAULT_AUTO_LINK_EXCLUDE_KINDS).map((k) => k.toLowerCase()))
  const max = Math.max(1, Math.min(10, opts.maxPerBlock || cfg.maxPerBlock || 2))
  let linkMentions = mentions.slice(0, max)
  if (excludedKinds.size > 0) {
    linkMentions = linkMentions.filter((m) => !excludedKinds.has(m.kind.toLowerCase()))
  }

  if (linkMentions.length === 0) {
    runtime.recordAutoLink(true)
    return { ...empty(), analyzed: 1, entities }
  }

  const links: AutoLinkAppliedLink[] = []
  const errors: string[] = []
  const skippedAnchors: NonNullable<AnalyzeResult['skippedAnchors']> = []
  const db = getDb()

  // 读源 block 所属文档（root_id 用于自指过滤）
  const blockRow = getBlockById(db, opts.blockId)
  const excludeSelfDoc = cfg.excludeSelfDoc ?? DEFAULT_AUTO_LINK_EXCLUDE_SELF_DOC
  const sourceDocId = excludeSelfDoc ? (blockRow?.root_id ?? null) : null

  for (const m of linkMentions) {
    try {
      const ranked = await findCandidates(opts.blockId, m.anchor, sourceDocId)
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

      // 竞态防护：抽取期间源块被整篇替换软删 → 不建链（见 doAnalyze 顶部软删防护）
      if (!getLiveBlockById(db, opts.blockId)) {
        if (skippedAnchors.length < 10) {
          skippedAnchors.push({ anchor: m.anchor, reason: 'source_deleted' })
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
    entities,
    errors,
    skippedLowConfidence,
    skippedAnchors: skippedAnchors.length > 0 ? skippedAnchors : undefined,
  }
}

function empty(): AnalyzeResult {
  return { analyzed: 0, applied: 0, links: [], entities: 0, errors: [] }
}

// ───────────────────── Extraction ─────────────────────

interface Mention {
  anchor: string
  kind: string
}

async function extractMentions(
  runtime: ReturnType<typeof getRuntime>,
  content: string,
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
  // 不在此截断 maxPerBlock：实体登记走全量（prompt 上限 5 个），建链侧再 slice
  return safeParseMentions(raw, content)
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

/** 批量抽取：一次 LLM 调用处理多个块（实体重建用，调用次数 ÷8） */
async function extractMentionsBatch(
  runtime: ReturnType<typeof getRuntime>,
  entries: Array<{ blockId: string; content: string }>,
): Promise<Map<string, Mention[]>> {
  const payload = JSON.stringify(entries.map((e) => ({ block_id: e.blockId, content: e.content.slice(0, MAX_CONTENT_CHARS) })))
  const messages: ChatMessage[] = [
    { role: 'system', content: EXTRACT_BATCH_SYSTEM_PROMPT },
    { role: 'user', content: payload },
  ]
  const raw = await runtime.chat(messages, {
    temperature: 0,
    maxTokens: 8000, // 32 块 × 5 mentions 的输出预算（BATCH_MAX_BLOCKS 上限）
    responseFormat: { type: 'json_object' },
  })
  return safeParseMentionsBatch(raw, entries)
}

/** 解析批量抽取结果：{blocks:[{block_id, mentions}]} → Map<blockId, Mention[]> */
function safeParseMentionsBatch(raw: string, entries: Array<{ blockId: string; content: string }>): Map<string, Mention[]> {
  const cleaned = raw
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
  const out = new Map<string, Mention[]>()
  const contentByBlock = new Map(entries.map((e) => [e.blockId, e.content]))
  if (!json || typeof json !== 'object') return out
  const arr = (json as { blocks?: unknown }).blocks
  if (!Array.isArray(arr)) return out
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const bid = (item as { block_id?: unknown }).block_id
    const list = (item as { mentions?: unknown }).mentions
    if (typeof bid !== 'string' || !Array.isArray(list)) continue
    const sourceContent = contentByBlock.get(bid) ?? ''
    const mentions: Mention[] = []
    for (const m of list) {
      if (!m || typeof m !== 'object') continue
      const a = (m as { anchor?: unknown }).anchor
      const k = (m as { kind?: unknown }).kind
      if (typeof a !== 'string' || a.length < 3 || a.length > 20) continue
      if (!sourceContent.includes(a)) continue
      const kind = typeof k === 'string' && ['concept', 'tool', 'person', 'doc'].includes(k) ? k : 'concept'
      mentions.push({ anchor: a.trim(), kind })
    }
    out.set(bid, mentions)
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

/**
 * 全 doc 重抽（升格 inbox/archived→note、取消 ai_exclude 后补齐实体与链）。
 * fire-and-forget 逐块 analyze：全局限速自然生效，不阻塞请求。
 * 提及/引用均幂等（UNIQUE / findRefByPair），无需先清理。
 */
export function reanalyzeDoc(docId: string): void {
  if (!hasRuntime() || !getRuntime().hasChat()) return
  const cfg = getRuntime().autoLinkConfig()
  const db = getDb()
  const rows = fetchDocBlocks(db, docId)
  for (const row of rows) {
    void analyzeBlock({
      blockId: row.id,
      content: row.content || '',
      maxPerBlock: cfg.maxPerBlock,
      entitiesOnly: row.type === 'document',
    }).catch((e) => console.warn('[autoLink] reanalyzeDoc:', e instanceof Error ? e.message : e))
  }
}
