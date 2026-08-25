/**
 * 服务端 Markdown 入库解析。
 *
 * 默认 mdast。`NOTEFAST_MARKDOWN_PARSER=legacy` 回退手写 parser；
 * `shadow` 双跑后仍写 mdast。日志只含块数与差异路径，不含正文。
 */

import { parseMarkdownForPersistence, safeLogError, safeLogWarn } from '@notefast/core'
import type { CreateBlockInput, MarkdownParserMode } from '@notefast/core'

export function readMarkdownParserMode(): MarkdownParserMode {
  const raw = (process.env.NOTEFAST_MARKDOWN_PARSER || '').trim().toLowerCase()
  if (raw === 'legacy' || raw === 'shadow') return raw
  return 'mdast'
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
