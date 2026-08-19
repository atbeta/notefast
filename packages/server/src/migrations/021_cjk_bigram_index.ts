import type { Database } from 'bun:sqlite'
import { rebuildCjkNgrams } from '../cjkNgrams'

/**
 * 021：CJK 子串倒排（汉字滑动 bigram）。
 *
 * LIKE '%词%' 无法走索引；FTS5 trigram 有 2 字死区。本表只索引连续汉字
 * 2-gram，检索先按 gram 交集取候选，再 LIKE 校验，语义与全表 LIKE 一致。
 */
export const id = '021_cjk_bigram_index'
export const description = 'CJK substring index via Han bigram table (LIKE candidate prefilter)'

export function up(db: Database): void {
  rebuildCjkNgrams(db)
}
