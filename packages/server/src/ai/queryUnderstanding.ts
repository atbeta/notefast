/**
 * 查询理解（增强检索预处理）
 *
 * 用 chat 模型把自然语言问句拆成词法检索用的 term 组（组间 AND、组内 OR），
 * 可选输出短 rewritten 供语义/实体通道。失败 / 超时 / 未配 chat → 降级，
 * 调用方继续走普通 hybridSearch（与今天 bit-identical）。
 *
 * 设计约束：
 * - 不写回 term-dict（词典仍是人工策展层）
 * - 不做物理分词（jieba 等）；确定性 CJK 剥离仍在 lexicalSearch 默认路径
 * - autoLink 等精度敏感路径不要开
 */

import { z } from 'zod'
import { fullToHalfWidth, parseLlmJson, type ChatMessage } from '@notefast/core'
import { getRuntime, hasRuntime } from '../services/aiRuntime'
import type { LexicalTermGroup } from '../lexicalSearch'

export type QueryUnderstandingStatus = 'applied' | 'skipped' | 'failed'

export interface UnderstoodQuery {
  status: QueryUnderstandingStatus
  /** status=applied 时有值；供 lexicalSearch.termGroups */
  termGroups?: LexicalTermGroup[]
  /** 语义/实体通道用：改写短查询，失败时等于原 query */
  semanticQuery: string
  /** 词法整句打分锚点 */
  sentence: string
  ms: number
}

const MAX_GROUPS = 6
const MAX_VARIANTS = 8
const MIN_TERM_LEN = 2
const MAX_TERM_LEN = 40
const DEFAULT_TIMEOUT_MS = 8_000

/** LLM 输出 schema：terms 为二维数组；rewritten 可选短查询 */
const understandingSchema = z.object({
  terms: z
    .array(z.array(z.string().min(1).max(MAX_TERM_LEN)).min(1).max(MAX_VARIANTS))
    .min(1)
    .max(MAX_GROUPS),
  rewritten: z.string().max(200).optional(),
})

const SYSTEM_PROMPT_ZH = `你是 NoteFast 知识库的查询理解模块。把用户检索问句拆成结构化检索词。

规则：
1. 只输出合法 JSON：{"terms":[["核心词","同义/别名"]],"rewritten":"短查询"}
2. terms：组间 AND（都必须命中）、组内 OR（任一写法即可）。每组 1-8 个写法，最多 6 组。
3. 去掉疑问/礼貌用语（怎么/如何/什么是/帮我/请问…），保留实体、产品名、技术词、关键约束。
4. 中置问句也要抽出核心：「怎么选向量数据库」→ [["向量数据库","向量库"],["选型","选择"]]
5. rewritten：10-30 字的短检索句，便于语义检索；不要完整复述原问句。
6. 不要解释、不要 markdown 围栏。`

const SYSTEM_PROMPT_EN = `You are NoteFast's query understanding module. Turn a search question into structured retrieval terms.

Rules:
1. Output valid JSON only: {"terms":[["core","synonym"]],"rewritten":"short query"}
2. terms: AND across groups, OR within a group. 1-8 variants per group, at most 6 groups.
3. Drop question fillers (how/what/please…); keep entities, product names, tech terms, key constraints.
4. rewritten: a short 3-12 word query for semantic search; do not echo the full question.
5. No explanations, no markdown fences.`

export interface UnderstandQueryOptions {
  lang?: 'zh' | 'en'
  /** LLM 调用超时（毫秒），默认 8000 */
  timeoutMs?: number
}

/**
 * 理解查询。任何失败路径返回 status=skipped|failed，semanticQuery/sentence=原串，
 * 且无 termGroups——调用方应忽略理解结果、走默认检索。
 */
export async function understandQuery(
  query: string,
  opts: UnderstandQueryOptions = {},
): Promise<UnderstoodQuery> {
  const start = Date.now()
  const original = query.trim()
  const base = (): UnderstoodQuery => ({
    status: 'skipped',
    semanticQuery: original,
    sentence: original,
    ms: Date.now() - start,
  })

  if (original.length < MIN_TERM_LEN) {
    return { ...base(), status: 'skipped', ms: Date.now() - start }
  }
  if (!hasRuntime() || !getRuntime().hasChat()) {
    return { ...base(), status: 'skipped', ms: Date.now() - start }
  }

  const lang = opts.lang ?? (/[一-鿿]/.test(original) ? 'zh' : 'en')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const messages: ChatMessage[] = [
    { role: 'system', content: lang === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH },
    { role: 'user', content: original },
  ]

  let raw: string
  try {
    raw = await withTimeout(
      getRuntime().chat(messages, {
        temperature: 0,
        maxTokens: 400,
        responseFormat: { type: 'json_object' },
      }),
      timeoutMs,
    )
  } catch (e) {
    console.warn('[queryUnderstanding] LLM failed, degrade:', (e as Error)?.message ?? e)
    return { ...base(), status: 'failed', ms: Date.now() - start }
  }

  const parsed = parseUnderstandingJson(raw)
  if (!parsed) {
    return { ...base(), status: 'failed', ms: Date.now() - start }
  }

  const termGroups = normalizeTermGroups(parsed.terms)
  if (termGroups.length === 0) {
    return { ...base(), status: 'failed', ms: Date.now() - start }
  }

  const rewritten = (parsed.rewritten ?? '').trim()
  const semanticQuery = rewritten.length >= MIN_TERM_LEN ? rewritten.slice(0, 200) : original

  return {
    status: 'applied',
    termGroups,
    semanticQuery,
    sentence: original,
    ms: Date.now() - start,
  }
}

/** 纯函数：清洗 LLM raw → schema 对象（可单测）；容错解析走 core 的 parseLlmJson */
export function parseUnderstandingJson(raw: string): z.infer<typeof understandingSchema> | null {
  const json = parseLlmJson(raw)
  const result = understandingSchema.safeParse(json)
  return result.success ? result.data : null
}

/** 纯函数：归一化 term 组（全半角、长度、去重、截断） */
export function normalizeTermGroups(terms: string[][]): LexicalTermGroup[] {
  const groups: LexicalTermGroup[] = []
  for (const row of terms) {
    if (!Array.isArray(row)) continue
    const seen = new Set<string>()
    const variants: string[] = []
    for (const raw of row) {
      if (typeof raw !== 'string') continue
      const v = fullToHalfWidth(raw.trim())
      if (v.length < MIN_TERM_LEN || v.length > MAX_TERM_LEN) continue
      const key = v.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      variants.push(v)
      if (variants.length >= MAX_VARIANTS) break
    }
    if (variants.length > 0) groups.push({ variants })
    if (groups.length >= MAX_GROUPS) break
  }
  return groups
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('query_understanding_timeout')), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}
