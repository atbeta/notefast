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
