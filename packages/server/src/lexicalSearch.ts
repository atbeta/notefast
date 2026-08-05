/**
 * 词法检索统一入口（FTS5 + LIKE 双路合并）
 *
 * 背景：unicode61 不切分 CJK，无空格中文查询（如「向量数据库怎么选」）在 FTS5 里
 * 变成一个整 token 短语，只有文档里出现被标点/空格包围的完全相同字串才命中。
 * trigram 分词器有 2 字词死区（「笔记」「主权」不进索引），不可用。
 * 因此中文召回走 LIKE 子串匹配（CJK 无需分词），ASCII 沿用 FTS5 bm25：
 *
 *   - FTS 路：仅当查询含 ASCII term 时运行（加引号 AND），bm25 排序
 *   - LIKE 严格路：所有 term 子串 AND（SQLite LIKE 对 ASCII 不区分大小写），
 *     排序权重：整句命中(100) > 命中 term 数(10/个) > 标题命中(1)
 *   - LIKE 降级路：严格路零结果且 strictOnly=false 时，term OR + 命中数排序
 *   - 合并：LIKE 路在前（CJK 召回主力），FTS 路按 bm25 顺序补充未出现的 id
 *   - 实体词典（term-dict）：term 命中词典别名/标准名 → 组内 OR 展开
 *     （查 wafer 命中「晶圆」文档）；组间沿用 AND/OR 语义，展开不变宽召回语义
 *
 * 供 hybridSearch / web /search / MCP notefast_search / autoLink 四处共用；
 * ai_exclude / 生命周期状态等后置过滤仍由调用方负责。
 */

import { getDb } from './db'
import { runFtsQuery } from './dbQueries'
import { expandDictTerm } from './termDict'

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

/**
 * CJK 问句常见前缀（按长度降序，先剥长前缀）。
 * 「什么是XXX / 如何做Y / 为什么Z」这类问句整句是一个 term，LIKE 子串匹配要求
 * 完整句序——文档里是「XXX是什么」就命中不了。剥离前缀后核心词「XXX」可命中。
 */
const CJK_QUERY_PREFIXES = [
  '介绍一下', '解释一下', '讲解一下', '说一下', '讲一下', '聊一下', '谈一下',
  '什么是', '怎么样', '为什么', '为啥', '为何', '如何', '怎么', '怎样',
  '哪个', '哪些', '谁', '哪里', '有没有', '请问', '帮我', '聊聊', '谈谈', '说说',
  '搭建', '部署', '使用', '实现', '安装', '配置', '选择', '学习', '了解', '研究', '解决', '知道',
].sort((a, b) => b.length - a.length)

/**
 * 提取 CJK term 的核心词：循环剥离疑问/指示/动作前缀（剥到稳定）。
 * 如「如何选择向量数据库」→「向量数据库」。
 * 剥离后 < 2 字符则保留原 term（避免「什么是A」误伤成单字）。
 */
function cjkCoreTerm(term: string): string {
  let cur = term
  let prev = ''
  while (cur !== prev) {
    prev = cur
    for (const p of CJK_QUERY_PREFIXES) {
      if (cur.startsWith(p)) {
        cur = cur.slice(p.length)
        break
      }
    }
  }
  return cur.trim().length >= 2 ? cur : term
}

/** LIKE 字面量转义（配合 ESCAPE '\'）：反斜杠自身、%、_ */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/**
 * term 组：词典命中时一个查询 term 展开为多个候选写法（原词 + 标准名 + 别名）。
 * 组内是「多选一」（OR），组间沿用 AND/OR 语义——展开绝不能变成新的 AND 条件。
 */
interface TermGroup {
  variants: string[]
}

/** 单组 LIKE 条件（组内 OR）：(col LIKE ? ESCAPE '\' OR ...) */
function groupLikeCond(col: string, g: TermGroup): string {
  return `(${g.variants.map(() => `${col} LIKE ? ESCAPE '\\'`).join(' OR ')})`
}

/** 整组 LIKE 参数（转义后 %term%） */
function groupLikeParams(g: TermGroup): string[] {
  return g.variants.map((v) => `%${escapeLike(v)}%`)
}

interface LikeRow {
  id: string
  type: string
  content: string
  root_id: string
  doc_title: string
}

/** LIKE 路：严格 AND 或降级 OR，共用同一套打分（整句 100 + 组命中数 10/个 + 标题 1） */
function runLikePath(
  groups: TermGroup[],
  opts: LexicalSearchOptions,
  orMode: boolean,
  sentence: string,
): LikeRow[] {
  const db = getDb()
  const params: (string | number)[] = []

  // 打分表达式：整句命中 > 组命中数 > 标题（root content 含任一 variant）
  // 整句命中蕴含全部组命中，权重不会倒挂；标题分只用于打破平局。
  // 整句按展开前的原始查询串判断（保持「原句序命中」的语义，不因展开变宽）
  let scoreSql = '(CASE WHEN b.content LIKE ? ESCAPE \'\\\' THEN 100 ELSE 0 END)'
  params.push(`%${escapeLike(sentence)}%`)
  scoreSql += ` + (${groups.map((g) => `CASE WHEN ${groupLikeCond('b.content', g)} THEN 1 ELSE 0 END`).join(' + ')}) * 10`
  for (const g of groups) params.push(...groupLikeParams(g))
  scoreSql += ` + (CASE WHEN ${groups.map((g) => groupLikeCond('d.content', g)).join(' OR ')} THEN 1 ELSE 0 END)`
  for (const g of groups) params.push(...groupLikeParams(g))

  let sql = `
    SELECT b.id, b.type, b.content, b.root_id, d.content AS doc_title, ${scoreSql} AS like_score
    FROM blocks b
    LEFT JOIN blocks d ON d.id = b.root_id
    WHERE b.is_deleted = 0`
  const joiner = orMode ? ' OR ' : ' AND '
  sql += ` AND (${groups.map((g) => groupLikeCond('b.content', g)).join(joiner)})`
  for (const g of groups) params.push(...groupLikeParams(g))

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
  let terms = query.split(/\s+/).filter(Boolean)
  if (terms.length === 0 || opts.limit <= 0) return []

  // CJK 问句归一化：「什么是XXX」→ 核心词「XXX」（无空格中文整句是一个 term，
  // 子串匹配要求完整句序，文档里是「XXX是什么」就漏检）。匹配/打分统一用核心词。
  terms = [...new Set(terms.map((t) => (CJK_RE.test(t) ? cjkCoreTerm(t) : t)))]

  // 词典展开：term 命中实体词典 → 组（原词 + 标准名 + 别名）；组内 OR，组间沿用原语义
  const groups: TermGroup[] = terms.map((t) => {
    const expanded = expandDictTerm(t)
    return { variants: expanded && expanded.length > 0 ? expanded : [t] }
  })
  // 整句命中按展开前（词典剥离前）的核心词判断
  const sentence = terms.join(' ')

  // ── LIKE 路（所有 term，含 ASCII——SQLite LIKE 对 ASCII 不区分大小写）──
  let likeRows = runLikePath(groups, opts, false, sentence)
  let orFallback = false
  if (likeRows.length === 0 && !opts.strictOnly) {
    likeRows = runLikePath(groups, opts, true, sentence)
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

  // ── FTS 路（含 ASCII 原词的查询才跑；匹配用全组——CJK 组以引号短语形式进
  // MATCH 提供 AND 约束，避免「wafer 光刻」只查 wafer 变体而漏掉光刻约束）──
  let ftsHits: LexicalHit[] = []
  if (terms.some((t) => !CJK_RE.test(t))) {
    // 组内 OR（"wafer" OR "晶圆"），组间 AND；转义规则与 buildFtsQuery 一致
    const match = groups
      .map((g) => {
        const quoted = g.variants
          .map((v) => `"${v.replace(/['"*()]/g, ' ').trim()}"`)
          .filter((v) => v.length > 2)
        if (quoted.length === 0) return ''
        return quoted.length === 1 ? quoted[0] : `(${quoted.join(' OR ')})`
      })
      .filter(Boolean)
      .join(' AND ')
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
