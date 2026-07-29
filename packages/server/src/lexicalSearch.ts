/**
 * 词法检索统一入口（FTS5 + LIKE 双路合并）
 *
 * 背景：unicode61 不切分 CJK，无空格中文查询（如「向量数据库怎么选」）在 FTS5 里
 * 变成一个整 token 短语，只有文档里出现被标点/空格包围的完全相同字串才命中。
 * trigram 分词器有 2 字词死区（「笔记」「主权」不进索引），不可用。
 * 因此中文召回走 LIKE 子串匹配（CJK 无需分词），ASCII 沿用 FTS5 bm25：
 *
 *   - FTS 路：仅当查询含 ASCII term 时运行（buildFtsQuery 加引号 AND），bm25 排序
 *   - LIKE 严格路：所有 term 子串 AND（SQLite LIKE 对 ASCII 不区分大小写），
 *     排序权重：整句命中(100) > 命中 term 数(10/个) > 标题命中(1)
 *   - LIKE 降级路：严格路零结果且 strictOnly=false 时，term OR + 命中数排序
 *   - 合并：LIKE 路在前（CJK 召回主力），FTS 路按 bm25 顺序补充未出现的 id
 *
 * 供 hybridSearch / web /search / MCP notefast_search / autoLink 四处共用；
 * ai_exclude / 生命周期状态等后置过滤仍由调用方负责。
 */

import { buildFtsQuery } from '@notefast/core'
import { getDb } from './db'
import { runFtsQuery } from './dbQueries'

export interface LexicalHit {
  id: string
  content: string
  root_id: string
  doc_title: string
  /** block 类型（hybridSearch 的 citation / MCP 返回需要） */
  type: string
  /** 合成排名分（列表内位置用，非跨通道可比分） */
  rank_score: number
  /** 命中来源（调试/报告用） */
  matched_by: 'fts' | 'like_and' | 'like_or' | 'title'
}

export interface LexicalSearchOptions {
  notebookId?: string
  limit: number
  since?: string
  until?: string
  /** 与 runFtsQuery 同语义：以 AND 开头的 WHERE 片段，与 extraParams 一一对应 */
  extraWhere?: string[]
  extraParams?: (string | number)[]
  /** true 时禁用 OR 降级（autoLink 用，保精度） */
  strictOnly?: boolean
  /** true 时只查文档根块（type='document'）——标题通道 */
  titleOnly?: boolean
}

/** CJK 统一表意文字基本区：含任一即视为 CJK term（FTS 帮不上忙，走 LIKE） */
const CJK_RE = /[一-鿿]/

/** LIKE 字面量转义（配合 ESCAPE '\'）：反斜杠自身、%、_ */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

interface LikeRow {
  id: string
  type: string
  content: string
  root_id: string
  doc_title: string
}

/** LIKE 路：严格 AND 或降级 OR，共用同一套打分（整句 100 + 命中数 10/个 + 标题 1） */
function runLikePath(
  terms: string[],
  opts: LexicalSearchOptions,
  orMode: boolean,
): LikeRow[] {
  const db = getDb()
  const params: (string | number)[] = []

  // 打分表达式：整句命中 > 命中 term 数 > 标题（root content 含任一 term）
  // 整句命中蕴含全部 term 命中，权重不会倒挂；标题分只用于打破平局
  let scoreSql = '(CASE WHEN b.content LIKE ? ESCAPE \'\\\' THEN 100 ELSE 0 END)'
  params.push(`%${escapeLike(terms.join(' '))}%`)
  scoreSql += ` + (${terms.map(() => `CASE WHEN b.content LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END`).join(' + ')}) * 10`
  for (const t of terms) params.push(`%${escapeLike(t)}%`)
  scoreSql += ` + (CASE WHEN ${terms.map(() => `d.content LIKE ? ESCAPE '\\'`).join(' OR ')} THEN 1 ELSE 0 END)`
  for (const t of terms) params.push(`%${escapeLike(t)}%`)

  let sql = `
    SELECT b.id, b.type, b.content, b.root_id, d.content AS doc_title, ${scoreSql} AS like_score
    FROM blocks b
    LEFT JOIN blocks d ON d.id = b.root_id
    WHERE b.is_deleted = 0`
  const joiner = orMode ? ' OR ' : ' AND '
  sql += ` AND (${terms.map(() => `b.content LIKE ? ESCAPE '\\'`).join(joiner)})`
  for (const t of terms) params.push(`%${escapeLike(t)}%`)

  if (opts.notebookId) {
    sql += ' AND b.notebook_id = ?'
    params.push(opts.notebookId)
  }
  if (opts.since) {
    sql += ' AND b.updated_at >= ?'
    params.push(opts.since)
  }
  if (opts.until) {
    sql += ' AND b.updated_at <= ?'
    params.push(opts.until)
  }
  if (opts.titleOnly) {
    sql += ` AND b.type = 'document'`
  }
  if (opts.extraWhere) {
    for (const clause of opts.extraWhere) sql += ` ${clause}`
    params.push(...(opts.extraParams ?? []))
  }

  sql += ' ORDER BY like_score DESC, b.updated_at DESC LIMIT ?'
  params.push(opts.limit)

  return db.query(sql).all(...(params as [string, ...(string | number)[]])) as LikeRow[]
}

interface FtsRow extends LikeRow {
  rank: number
}

export function lexicalSearch(query: string, opts: LexicalSearchOptions): LexicalHit[] {
  const terms = query.split(/\s+/).filter(Boolean)
  if (terms.length === 0 || opts.limit <= 0) return []

  // ── LIKE 路（所有 term，含 ASCII——SQLite LIKE 对 ASCII 不区分大小写）──
  let likeRows = runLikePath(terms, opts, false)
  let orFallback = false
  if (likeRows.length === 0 && !opts.strictOnly) {
    likeRows = runLikePath(terms, opts, true)
    orFallback = likeRows.length > 0
  }
  const likeMatchedBy: LexicalHit['matched_by'] = opts.titleOnly
    ? 'title'
    : orFallback
      ? 'like_or'
      : 'like_and'
  const likeHits: LexicalHit[] = likeRows.map((r) => ({
    id: r.id,
    content: r.content,
    root_id: r.root_id,
    doc_title: r.doc_title ?? '',
    type: r.type,
    rank_score: 0, // 合并后统一合成
    matched_by: likeMatchedBy,
  }))

  // ── FTS 路（仅 ASCII term；CJK term 在 unicode61 下是整 token 短语，召回交给 LIKE）──
  const asciiTerms = terms.filter((t) => !CJK_RE.test(t))
  let ftsHits: LexicalHit[] = []
  if (asciiTerms.length > 0) {
    const { query: match } = buildFtsQuery(asciiTerms.join(' '), opts.limit)
    if (match) {
      const extraWhere = [...(opts.extraWhere ?? [])]
      if (opts.titleOnly) extraWhere.push(`AND b.type = 'document'`)
      try {
        const rows = runFtsQuery<FtsRow>(getDb(), {
          match,
          notebookId: opts.notebookId,
          since: opts.since,
          until: opts.until,
          limit: opts.limit,
          select: `b.id, b.type, b.content, b.root_id,
                   (SELECT content FROM blocks WHERE id = b.root_id) as doc_title, rank`,
          extraWhere: extraWhere.length > 0 ? extraWhere : undefined,
          extraParams: opts.extraParams,
        })
        ftsHits = rows.map((r) => ({
          id: r.id,
          content: r.content,
          root_id: r.root_id,
          doc_title: r.doc_title ?? '',
          type: r.type,
          rank_score: 0,
          matched_by: 'fts' as const,
        }))
      } catch (e) {
        // FTS 表达式异常不拖垮 LIKE 路（原 autoLink 的降级语义上移到这里）
        console.error('[lexicalSearch] FTS path failed:', e)
      }
    }
  }

  // ── 合并：LIKE 路在前，FTS 路按 bm25 顺序补充未出现的 id ──
  const seen = new Set(likeHits.map((h) => h.id))
  const merged = [...likeHits, ...ftsHits.filter((h) => !seen.has(h.id))].slice(0, opts.limit)
  const n = merged.length
  return merged.map((h, i) => ({ ...h, rank_score: n <= 1 ? 1 : 1 - i / n }))
}
