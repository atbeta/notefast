/**
 * AutoLink 引擎
 *
 * 流程：
 *   1) LLM 从块内容里抽出 mention 列表（严格 JSON）
 *   2) 每个 mention.anchor 去命中现有 block（hybrid search）
 *   3) 生成建议入内存 store；autoApply=true 时直接写 block_refs
 *
 * 配置：
 *   - chat 必须可用；embedding 不必须（纯 FTS5 也行）
 *   - notebookScope='same' 时仅匹配同 notebook
 */

import type { ChatMessage } from '@notefast/core'
import { getDb } from '../db'
import { getRuntime, hasRuntime } from '../services/aiRuntime'
import { addSuggestions, type AutoLinkSuggestion } from './autoLinkStore'

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
  /** 块内容；超过 MAX_CONTENT_CHARS 自动截断到首段 */
  content: string
  notebookId?: string
  notebookScope: 'all' | 'same'
  maxPerBlock: number
}

export interface AnalyzeResult {
  analyzed: number
  suggestionsAdded: number
  suggestions: AutoLinkSuggestion[]
  applied: number
  errors: string[]
}

/** 主入口：分析单个 block，必要时直接落库；返回纯统计 */
export async function analyzeBlock(opts: AnalyzeOptions): Promise<AnalyzeResult> {
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

  for (const m of mentions) {
    try {
      const candidates = await findCandidates(opts.blockId, m.anchor, opts.notebookId, opts.notebookScope)
      if (candidates.length === 0) continue
      const sug: AutoLinkSuggestion = {
        id: crypto.randomUUID(),
        sourceBlockId: opts.blockId,
        anchor: m.anchor,
        kind: m.kind,
        candidates,
        createdAt: new Date().toISOString(),
      }
      suggestions.push(sug)
      // autoApply: 立即落库
      if (cfg.autoApply) {
        const target = candidates[0]!.blockId
        try {
          insertRef(opts.blockId, target, 'ai_link')
          applied++
        } catch (e) {
          errors.push(`apply ${m.anchor}: ${e instanceof Error ? e.message : e}`)
        }
      }
    } catch (e) {
      errors.push(`${m.anchor}: ${e instanceof Error ? e.message : e}`)
    }
  }

  if (!cfg.autoApply && suggestions.length > 0) {
    addSuggestions(suggestions)
  }

  runtime.recordAutoLink(errors.length === 0, errors[0])
  return { analyzed: 1, suggestionsAdded: suggestions.length, suggestions, applied, errors }
}

function empty(): AnalyzeResult {
  return { analyzed: 0, suggestionsAdded: 0, suggestions: [], applied: 0, errors: [] }
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
  // 模型有时把 JSON 包到 ```json ... ``` 里
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
): Promise<AutoLinkSuggestion['candidates']> {
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
  sql += ' ORDER BY rank LIMIT 5'

  let rows: Array<{ id: string; content: string; root_id: string; doc_title: string }>
  try {
    rows = db.query(sql).all(...params as [string, ...(string | number)[]]) as Array<{
      id: string
      content: string
      root_id: string
      doc_title: string
    }>
  } catch {
    // 极端 anchor 导致 FTS 解析失败时降级到 LIKE
    const likeSql = `SELECT b.id, b.content, b.root_id, (SELECT content FROM blocks WHERE id = b.root_id) as doc_title
                     FROM blocks b WHERE b.content LIKE ? AND b.id != ? LIMIT 5`
    rows = db.query(likeSql).all(`%${anchor}%`, sourceBlockId) as Array<{
      id: string
      content: string
      root_id: string
      doc_title: string
    }>
  }

  if (rows.length === 0) return []

  // 如果有 embedding，用余弦重排；否则用 FTS 自带的 rank 当作 confidence proxy
  const ranked = rows.map((r, i) => ({
    blockId: r.id,
    docId: r.root_id,
    docTitle: r.doc_title,
    snippet: r.content.slice(0, 120),
    confidence: 1 / (1 + i),
  }))

  if (hasRuntime() && getRuntime().hasEmbedding()) {
    try {
      const r = getRuntime()
      const qv = await r.embedQuery(anchor)
      if (qv) {
        const { cosineSimilarity } = await import('@notefast/core')
        const vectors = rows.map((row) => {
          const v = db.query('SELECT embedding FROM block_vectors WHERE block_id = ?').get(row.id) as
            | { embedding: string }
            | undefined
          if (!v) return null
          try {
            return new Float64Array(JSON.parse(v.embedding))
          } catch {
            return null
          }
        })
        for (let i = 0; i < ranked.length; i++) {
          const v = vectors[i]
          if (!v) continue
          const sim = cosineSimilarity(qv, v)
          ranked[i]!.confidence = Math.max(ranked[i]!.confidence, sim)
        }
        ranked.sort((a, b) => b.confidence - a.confidence)
      }
    } catch {
      // embedding 不可用时继续使用 FTS rank
    }
  }

  return ranked.slice(0, 3)
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
