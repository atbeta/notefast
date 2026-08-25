/**
 * 持久化入口用的 Markdown 解析（导入 / 整篇保存）。
 *
 * 默认仍用手写 parser。shadow 模式双跑 mdast，但始终返回手写结果；
 * 对照报告不含正文，只含块数与第一处差异路径。
 */

import type { CreateBlockInput } from '../types'
import { parseMarkdownToBlocks } from '../markdown'
import { parseMarkdownToBlocksMdast } from './parseMdast'
import { firstSemanticDiff, toSemanticForest } from './semantics'

export type MarkdownParserMode = 'legacy' | 'shadow'

export interface ParserShadowReport {
  match: boolean
  legacyCount: number
  mdastCount: number
  /** 不含正文，如 `0.type` */
  firstDiff?: string
  /** mdast 抛错时的短消息，不含源码 */
  mdastError?: string
}

export function parseMarkdownForPersistence(
  markdown: string,
  notebookId: string,
  opts?: {
    mode?: MarkdownParserMode
    onShadow?: (report: ParserShadowReport) => void
  },
): CreateBlockInput[] {
  const legacy = parseMarkdownToBlocks(markdown, notebookId)
  if (opts?.mode !== 'shadow') return legacy

  try {
    const mdast = parseMarkdownToBlocksMdast(markdown, notebookId)
    const left = toSemanticForest(legacy)
    const right = toSemanticForest(mdast)
    const firstDiff = firstSemanticDiff(left, right) ?? undefined
    opts.onShadow?.({
      match: firstDiff == null,
      legacyCount: legacy.length,
      mdastCount: mdast.length,
      firstDiff,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    opts.onShadow?.({
      match: false,
      legacyCount: legacy.length,
      mdastCount: 0,
      mdastError: message.slice(0, 200),
    })
  }
  return legacy
}
