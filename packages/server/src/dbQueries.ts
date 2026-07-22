/**
 * 通用 block 查询辅助
 *
 * 收敛原先散落在 8 个文件里逐字节相同的 N+1 DFS
 * （每个节点一次 SELECT ... WHERE parent_id = ?）：
 * - fetchDocBlocks：文档级拉取（含文档根本身），走 root_id 索引一条查询
 * - fetchSubtreeBlocks：任意子树后代（不含起点本身），递归 CTE 一条查询
 *
 * 两者统一按 level, sort 排序返回；buildBlockTree 内部会按 sort 重排子节点，
 * 扁平行顺序不影响建树结果。
 */

import type { BlockRow } from '@notefast/core'
import type { getDb } from './db'

type Db = ReturnType<typeof getDb>

/** 文档级拉取：root_id 下全部 block（含文档根本身），按 level, sort 排序 */
export function fetchDocBlocks(db: Db, rootId: string): BlockRow[] {
  return db
    .query('SELECT * FROM blocks WHERE root_id = ? ORDER BY level, sort')
    .all(rootId) as BlockRow[]
}

/** 任意子树后代（不含起点本身），按 level, sort 排序 */
export function fetchSubtreeBlocks(db: Db, blockId: string): BlockRow[] {
  return db
    .query(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM blocks WHERE parent_id = ?
         UNION
         SELECT b.id FROM blocks b JOIN subtree s ON b.parent_id = s.id
       )
       SELECT b.* FROM blocks b JOIN subtree s ON b.id = s.id
       ORDER BY b.level, b.sort`,
    )
    .all(blockId) as BlockRow[]
}

// ───────────────────── FTS5 全文检索 ─────────────────────
// 收敛原先散落在 api/search、api/ai（ftsHits）、mcp/tools（notefast_search）、
// ai/hybridSearch（runFts）、ai/autoLink（findCandidates）五处的同款拼装：
//   blocks_fts JOIN blocks ... MATCH ? ORDER BY rank LIMIT ?
// 各处差异全部参数化（见下方注释）；ai_exclude 等后置过滤仍由调用方负责。
// autoLink 的 LIKE 降级是独立语义，保留在调用方。

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
    WHERE blocks_fts MATCH ?`
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
