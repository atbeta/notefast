/**
 * 持久化入口用的 Markdown 解析（导入 / 整篇保存）。
 *
 * 默认写 mdast。`legacy` 回退手写 parser；`shadow` 双跑后仍写 mdast，
 * 对照报告不含正文，只含块数与第一处差异路径。mdast 抛错时回退手写结果。
 */

import type { CreateBlockInput } from '../types'
import { parseMarkdownToBlocksLegacy } from '../markdown'
import { parseMarkdownToBlocksMdast } from './parseMdast'
import { firstSemanticDiff, toSemanticForest } from './semantics'

export type MarkdownParserMode = 'legacy' | 'shadow' | 'mdast'

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
  const mode = opts?.mode ?? 'mdast'

  if (mode === 'legacy') {
    return parseMarkdownToBlocksLegacy(markdown, notebookId)
  }

  let mdastInputs: CreateBlockInput[] | undefined
  let mdastError: string | undefined
  try {
    mdastInputs = parseMarkdownToBlocksMdast(markdown, notebookId)
  } catch (err) {
    mdastError = (err instanceof Error ? err.message : String(err)).slice(0, 200)
  }

  if (mode === 'shadow') {
    const legacyInputs = parseMarkdownToBlocksLegacy(markdown, notebookId)
    if (mdastInputs && !mdastError) {
      const firstDiff = firstSemanticDiff(toSemanticForest(legacyInputs), toSemanticForest(mdastInputs)) ?? undefined
      opts?.onShadow?.({
        match: firstDiff == null,
        legacyCount: legacyInputs.length,
        mdastCount: mdastInputs.length,
        firstDiff,
      })
      return mdastInputs
    }
    opts?.onShadow?.({
      match: false,
      legacyCount: legacyInputs.length,
      mdastCount: 0,
      mdastError,
    })
    return legacyInputs
  }

  if (!mdastInputs) {
    opts?.onShadow?.({
      match: false,
      legacyCount: 0,
      mdastCount: 0,
      mdastError,
    })
    return parseMarkdownToBlocksLegacy(markdown, notebookId)
  }

  return mdastInputs
}
