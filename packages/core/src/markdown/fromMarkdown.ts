/**
 * NoteFast 共用的 Markdown → mdast 入口。
 * 禁用 Setext / 缩进代码；GFM 只开表格与任务列表。保存 mapper 与围栏扫描必须走这里。
 */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table'
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item'
import { gfmTable } from 'micromark-extension-gfm-table'
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item'

export function fromNoteFastMarkdown(markdown: string): unknown {
  return fromMarkdown(markdown, {
    extensions: [
      { disable: { null: ['setextUnderline', 'codeIndented'] } },
      gfmTable(),
      gfmTaskListItem(),
    ],
    mdastExtensions: [gfmTableFromMarkdown(), gfmTaskListItemFromMarkdown()],
  })
}
