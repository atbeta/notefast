/**
 * 实体登记 —— autoLink 一次 LLM 抽取的第二条消费线
 *
 * 写入时理解引擎的两条消费线：
 * 1. 建链：kind 过滤 + 语义门槛 + minMargin → block_refs(ai_auto)
 * 2. 实体登记（本模块）：不过滤 kind，全量 → entities + entity_mentions
 *
 * 归并策略：规范化名精确匹配（重复实体比错误合并代价小）。
 * 更新重抽前由调用方先 deleteMentionsFromSource 清理旧提及（双清理）。
 */

import { getDb } from '../db'
import {
  addMention,
  normalizeEntityName,
  upsertEntity,
} from '../store/entities'

export interface MentionInput {
  anchor: string
  kind: string
}

/**
 * 把一个 block 抽出的 mentions 登记进实体表（幂等：UNIQUE(entity_id, block_id)）。
 * 返回本次登记的不同实体数（按规范化名去重后）。
 */
export function registerMentions(blockId: string, mentions: MentionInput[]): number {
  if (mentions.length === 0) return 0
  const db = getDb()
  const seen = new Set<string>()
  let registered = 0
  for (const m of mentions) {
    const name = normalizeEntityName(m.anchor)
    if (name.length < 2 || seen.has(name)) continue
    seen.add(name)
    const entity = upsertEntity(db, { name, display: m.anchor.trim(), kind: m.kind })
    addMention(db, entity.id, blockId, m.anchor.trim())
    registered++
  }
  return registered
}
