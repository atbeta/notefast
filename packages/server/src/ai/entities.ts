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
import { getLiveBlockById } from '../store/blocks'
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
 *
 * 软删防护：登记前校验 block 仍是活块（is_deleted = 0）。afterCreate 抽取是
 * fire-and-forget + 限速（延迟可达数秒），若文档在抽取完成前被整篇替换，替换路径
 * 的清理先跑、抽取后到，会把 mention 落在已软删块上成为「幽灵数据」——此处拒绝。
 */
export function registerMentions(blockId: string, mentions: MentionInput[]): number {
  if (mentions.length === 0) return 0
  const db = getDb()
  // 已软删块：不登记（竞态残留源头，见函数注释）
  if (!getLiveBlockById(db, blockId)) return 0
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
