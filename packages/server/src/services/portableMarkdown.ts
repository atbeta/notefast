/**
 * 便携 Markdown（导出 / 归档）— DB 真相投影为正文 + frontmatter
 *
 * 编辑器加载仍用裸 blocksToMarkdown（/docs/:id/export/markdown），勿走这里。
 */

import {
  blocksToMarkdown,
  buildBlockTree,
  docFrontmatterFromRow,
  withDocFrontmatter,
  type BlockRow,
} from '@notefast/core'
import { getDb } from '../db'
import { fetchDocBlocks } from '../store/blocks'

/** 文档根行 → 带 frontmatter 的完整 Markdown（含 `# title` 正文） */
export function portableDocMarkdown(doc: BlockRow): string {
  const tree = buildBlockTree(fetchDocBlocks(getDb(), doc.id))
  return withDocFrontmatter(blocksToMarkdown(tree), docFrontmatterFromRow(doc))
}
