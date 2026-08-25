/**
 * 仅开围栏 info string 的语言补全。空语言合法，不强制写入。
 */

import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { FENCE_INFO_LANGUAGES } from '../../../lib/highlight'
import { fencedCodeSpansIn } from './fencedCode'

const FENCE_OPEN_RE = /^(\s*)([`~]{3,})([^\s`~]*)/

export function fenceInfoCompletion(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos)
  const match = FENCE_OPEN_RE.exec(line.text)
  if (!match) return null
  const infoFrom = line.from + match[1].length + match[2].length
  const infoTo = infoFrom + match[3].length
  if (context.pos < infoFrom || context.pos > infoTo) return null

  const onOpening = fencedCodeSpansIn(context.state.doc).some((span) => {
    return context.state.doc.lineAt(span.from).number === line.number
  })
  if (!onOpening) return null

  return {
    from: infoFrom,
    to: infoTo,
    options: FENCE_INFO_LANGUAGES.map((label) => ({ label, type: 'class' })),
    validFor: /^[\w+-]*$/,
  }
}
