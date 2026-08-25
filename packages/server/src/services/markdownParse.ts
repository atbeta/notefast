/**
 * 服务端 Markdown 入库解析。
 *
 * NOTEFAST_MARKDOWN_PARSER=legacy（默认）只走手写 parser。
 * NOTEFAST_MARKDOWN_PARSER=shadow 同时跑 mdast 对照，仍写入手写结果；
 * 日志只含块数与差异路径，不含正文。
 */

import { parseMarkdownForPersistence, safeLogError, safeLogWarn } from '@notefast/core'
import type { CreateBlockInput, MarkdownParserMode } from '@notefast/core'

export function readMarkdownParserMode(): MarkdownParserMode {
  const raw = (process.env.NOTEFAST_MARKDOWN_PARSER || '').trim().toLowerCase()
  return raw === 'shadow' ? 'shadow' : 'legacy'
}

export function parseMarkdownToBlocksForSave(markdown: string, notebookId: string): CreateBlockInput[] {
  return parseMarkdownForPersistence(markdown, notebookId, {
    mode: readMarkdownParserMode(),
    onShadow: (report) => {
      if (report.mdastError) {
        safeLogError('markdown parser shadow: mdast failed', {
          error: report.mdastError,
          legacyCount: report.legacyCount,
        })
        return
      }
      if (!report.match) {
        safeLogWarn('markdown parser shadow: semantic mismatch', {
          firstDiff: report.firstDiff,
          legacyCount: report.legacyCount,
          mdastCount: report.mdastCount,
        })
      }
    },
  })
}
