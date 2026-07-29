/**
 * FTS5 全文检索查询构建
 *
 * 收敛原先散落在 api/search、api/ai（ftsHits）、mcp/tools（notefast_search）、
 * ai/hybridSearch（runFts）、ai/autoLink（findCandidates）五处的同款拼装：
 *   blocks_fts JOIN blocks ... MATCH ? ORDER BY rank LIMIT ?
 * 各处差异全部参数化（见下方注释）；ai_exclude 等后置过滤仍由调用方负责。
 *
 * 现状：web /search、MCP notefast_search、hybridSearch、autoLink 四处已上移到
 * lexicalSearch（FTS5 + LIKE 双路，中文走 LIKE 子串召回），本模块仅剩
 * lexicalSearch 的 FTS 路与 api/ai 的 ftsHits（mode=fts 调试通道）两个直接调用方。
 *
 * 注意：blocks 表的普通读写不走这里，统一走 store/blocks.ts（数据访问层）。
 * FTS5 与 SQLite 共生，检索层不参与数据访问层抽象。
 */

import type { BlockRow } from '@notefast/core'
import type { getDb } from './db'

type Db = ReturnType<typeof getDb>

export interface RunFtsQueryOptions {
  /** FTS5 MATCH 表达式（调用方用 buildFtsQuery 或自定义转义生成） */
  match: string
  /** 限定笔记本（可选） */
  notebookId?: string
  /** blocks.updated_at 下界，ISO 字符串（可选） */
  since?: string
  /** blocks.updated_at 上界，ISO 字符串（可选） */
  until?: string
  /** 返回上限 */
  limit: number
  /**
   * 过取倍率（默认 1 = 不过取）。
   * >1 时 SQL LIMIT = limit * overfetch，供调用方后置过滤（如 ai_exclude）后截断。
   */
  overfetch?: number
  /**
   * SELECT 列表，默认 'b.*, rank'。
   * 自定义时必须保留 rank 列（ORDER BY rank 依赖）。
   */
  select?: string
  /** 追加的 WHERE 片段（需以 AND 开头），与 extraParams 一一对应 */
  extraWhere?: string[]
  extraParams?: (string | number)[]
}

/** FTS5 基础命中行：完整 block 行 + rank */
export type FtsBaseHit = BlockRow & { rank: number }

export function runFtsQuery<T = FtsBaseHit>(db: Db, opts: RunFtsQueryOptions): T[] {
  let sql = `
    SELECT ${opts.select ?? 'b.*, rank'} FROM blocks_fts f
    JOIN blocks b ON b.id = f.id
    WHERE blocks_fts MATCH ? AND b.is_deleted = 0`
  const params: (string | number)[] = [opts.match]

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
  if (opts.extraWhere) {
    for (const clause of opts.extraWhere) sql += ` ${clause}`
    params.push(...(opts.extraParams ?? []))
  }

  sql += ' ORDER BY rank LIMIT ?'
  params.push(opts.limit * (opts.overfetch ?? 1))

  return db.query(sql).all(...(params as [string, ...(string | number)[]])) as T[]
}
