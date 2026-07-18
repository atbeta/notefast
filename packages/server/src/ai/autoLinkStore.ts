/**
 * 内存中的 AutoLink 建议存储
 *
 * 设计原则：
 * - 单例；不持久化（重启即丢，符合"轻量 + 可选"）
 * - 每个建议关联一个 block_id（多建议共享一个 block）
 * - apply() 把建议变成不可变的 block_refs（ref_type='ai_link'）
 * - 当 block 内容被进一步更新，旧的建议"自然过期"——下一次 hook 重新分析覆盖
 */

import type { Citation } from './hybridSearch'

export interface AutoLinkSuggestion {
  /** 唯一 ID（uuid） */
  id: string
  /** 当前 block（被改动的） */
  sourceBlockId: string
  /** 原始 anchor 文本（"KMP"、"Bun" 等） */
  anchor: string
  /** 提取出的实体类型（concept / tool / person / doc） */
  kind: string
  /** 候选命中（多个时按 confidence 降序） */
  candidates: Array<{
    blockId: string
    docId: string
    docTitle: string
    snippet: string
    confidence: number
  }>
  /** 创建时间 */
  createdAt: string
}

interface BucketState {
  byBlock: Map<string, AutoLinkSuggestion[]>
}

const bucket: BucketState = { byBlock: new Map() }

export function addSuggestions(suggestions: AutoLinkSuggestion[]): void {
  for (const s of suggestions) {
    const arr = bucket.byBlock.get(s.sourceBlockId) ?? []
    // 去重：相同 anchor 已存在则替换
    const existingIdx = arr.findIndex((x) => x.anchor === s.anchor)
    if (existingIdx >= 0) arr[existingIdx] = s
    else arr.push(s)
    bucket.byBlock.set(s.sourceBlockId, arr)
  }
}

export function removeSuggestionsForBlock(blockId: string): void {
  bucket.byBlock.delete(blockId)
}

export function listSuggestionsForBlock(blockId: string): AutoLinkSuggestion[] {
  return bucket.byBlock.get(blockId) ?? []
}

export function listSuggestionsForDoc(_docId: string, blockIdsInDoc: string[]): AutoLinkSuggestion[] {
  const out: AutoLinkSuggestion[] = []
  for (const bid of blockIdsInDoc) {
    const arr = bucket.byBlock.get(bid)
    if (arr) out.push(...arr)
  }
  return out
}

export function findSuggestion(id: string): AutoLinkSuggestion | undefined {
  for (const arr of bucket.byBlock.values()) {
    const found = arr.find((s) => s.id === id)
    if (found) return found
  }
  return undefined
}

export function removeSuggestionById(id: string): boolean {
  for (const [bid, arr] of bucket.byBlock.entries()) {
    const idx = arr.findIndex((s) => s.id === id)
    if (idx >= 0) {
      arr.splice(idx, 1)
      if (arr.length === 0) bucket.byBlock.delete(bid)
      return true
    }
  }
  return false
}

export function clearAllSuggestions(): void {
  bucket.byBlock.clear()
}

/** 给前端展示时降级为简单形状（不暴露内部状态） */
export function toWire(s: AutoLinkSuggestion) {
  return {
    id: s.id,
    source_block_id: s.sourceBlockId,
    anchor: s.anchor,
    kind: s.kind,
    candidates: s.candidates.map((c) => ({
      block_id: c.blockId,
      doc_id: c.docId,
      doc_title: c.docTitle,
      snippet: c.snippet,
      confidence: Math.round(c.confidence * 1000) / 1000,
    })),
    created_at: s.createdAt,
  }
}

/** Re-export Citation type for callers */
export type { Citation }
