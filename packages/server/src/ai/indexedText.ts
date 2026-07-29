/**
 * 向量索引文本统一构建器
 *
 * 增量（indexBlock / indexBlockBatch）与全量重建（vectorRebuild）共用同一入口，
 * 保证两条路径的索引文本与 content_hash 语义完全一致。
 *
 * 输出格式（空段整体省略）：
 *
 *   标题：{doc 根块 content}
 *   章节：{H1 / H2 / H3}        // 沿 parent_id 上溯收集 heading，root 侧在前
 *   标签：{t1, t2}              // 取 root 行的 tags 显式列
 *
 *   {block.content}
 *
 *   [图片描述] {...}            // 图片理解开启且有可用 caption 时
 *
 * 标题/章节/标签属于「上下文」：它们变化不改 block.content，
 * 但会改变构建结果 → content_hash 变化 → 触发重索引（freshness 联动见 aiRuntime）。
 */

import { readTags, type BlockRow } from '@notefast/core'
import { getDb } from '../db'
import { getBlockById } from '../store/blocks'
import { captionForAsset, visionEnabled } from './imageCaptions'

/** 章节路径上溯的最大深度（防深嵌套拖慢构建，也兜住异常数据） */
const MAX_HEADING_DEPTH = 6

/** 沿 parent_id 链上溯收集 heading 文本（root 侧在前）；visited set 防循环 */
function collectHeadingPath(row: BlockRow): string[] {
  const headings: string[] = []
  const visited = new Set<string>([row.id])
  let parentId = row.parent_id
  while (parentId && visited.size <= MAX_HEADING_DEPTH && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = getBlockById(getDb(), parentId)
    if (!parent) break
    if (parent.type === 'heading') {
      const text = parent.content.trim()
      if (text) headings.unshift(text)
    }
    parentId = parent.parent_id
  }
  return headings
}

/**
 * 构建 block 的向量索引文本。
 * 正文（trim 后的 content）为空时返回 ''——与重建的 `trim(content) != ''`
 * 过滤一致，空块不进索引。
 */
export async function buildIndexedText(row: BlockRow): Promise<string> {
  const body = (row.content || '').trim()
  if (!body) return ''

  const db = getDb()
  const sections: string[] = []

  // 文档根块的 content 就是标题本身，不再重复进「标题/章节」段
  if (row.type !== 'document') {
    const root = getBlockById(db, row.root_id)
    const title = root?.content.trim()
    if (title) sections.push(`标题：${title}`)
    const headings = collectHeadingPath(row)
    if (headings.length > 0) sections.push(`章节：${headings.join(' / ')}`)
    if (root) {
      const tags = readTags(root)
      if (tags.length > 0) sections.push(`标签：${tags.join(', ')}`)
    }
  } else {
    const tags = readTags(row)
    if (tags.length > 0) sections.push(`标签：${tags.join(', ')}`)
  }

  let text = sections.length > 0 ? `${sections.join('\n')}\n\n${body}` : body

  // 图片理解：asset 引用追加 caption（沿用原 indexedTextWithCaptions 的拼接格式）
  if (visionEnabled() && body.includes('asset:')) {
    const refs: string[] = []
    for (const m of body.matchAll(/asset:([0-9a-f]{64})/g)) refs.push(m[1]!)
    const captions: string[] = []
    for (const id of refs) {
      const c = await captionForAsset(id)
      if (c) captions.push(c)
    }
    if (captions.length > 0) text += `\n\n[图片描述] ${captions.join('；')}`
  }

  return text
}
