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
import { resolveDictTerm } from '../termDict'
import {
  addMention,
  getEntityById,
  normalizeEntityName,
  resolveAlias,
  resolveVersionVariant,
  upsertEntity,
} from '../store/entities'

export interface MentionInput {
  anchor: string
  kind: string
}

/**
 * 代码标识符（snake_case / 点分符号名）不是知识实体——prompt 规则的确定性兜底，
 * LLM 不遵守排除规则时在此拦截（block_refs、mention_count、fs.readFile 等）。
 * 连字符名（react-markdown、sqlite-vec）与纯词（vec0）不受影响。
 */
export function looksLikeCodeIdentifier(normalizedName: string): boolean {
  return /^[\w.]+$/.test(normalizedName) && (normalizedName.includes('_') || normalizedName.includes('.'))
}

/**
 * 把一个 block 抽出的 mentions 登记进实体表（幂等：UNIQUE(entity_id, block_id)）。
 * 返回本次登记的不同实体数（按规范化名去重后）。
 *
 * 软删防护：登记前校验 block 仍是活块（is_deleted = 0）。afterCreate 抽取是
 * fire-and-forget + 限速（延迟可达数秒），若文档在抽取完成前被整篇替换，替换路径
 * 的清理先跑、抽取后到，会把 mention 落在已软删块上成为「幽灵数据」——此处拒绝。
 *
 * 别名路由：规范化名命中别名字典（手工合并过）→ 直接挂到规范实体，不再新建。
 * 词典路由：实体词典（用户声明的校准层）优先于别名字典——别名/标准名命中词典
 * 即收敛到词典标准名实体（声明层比合并产物更显式，覆盖旧合并）。
 */
export function registerMentions(blockId: string, mentions: MentionInput[]): number {
  if (mentions.length === 0) return 0
  const db = getDb()
  // 已软删块：不登记（竞态残留源头，见函数注释）
  if (!getLiveBlockById(db, blockId)) return 0
  const seen = new Set<string>()
  let registered = 0
  for (const m of mentions) {
    const rawName = normalizeEntityName(m.anchor)
    if (rawName.length < 2 || seen.has(rawName)) continue
    if (looksLikeCodeIdentifier(rawName)) continue
    seen.add(rawName)
    // 词典路由（声明层最高优先级）：别名 → 标准名
    const dictTarget = resolveDictTerm(rawName)
    const name = dictTarget ? dictTarget.name : rawName
    const display = dictTarget ? dictTarget.display : m.anchor.trim()
    // 版本变体（CodeMirror 6 → codemirror）路由到既有主名实体；
    // kind=doc 例外——编号文档是不同文档（「视觉验证测试文档 30」≠「视觉验证测试文档」）
    const aliasTarget =
      resolveAlias(db, name) ?? (m.kind === 'doc' ? null : resolveVersionVariant(db, name))
    const entity = aliasTarget
      ? getEntityById(db, aliasTarget)
      : upsertEntity(db, { name, display, kind: dictTarget?.kind ?? m.kind })
    if (!entity) continue
    addMention(db, entity.id, blockId, m.anchor.trim())
    registered++
  }
  return registered
}
