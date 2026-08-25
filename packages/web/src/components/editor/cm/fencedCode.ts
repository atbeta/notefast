/**
 * 编辑器文档上的围栏区间。doc 不可变，按 Text 身份缓存，避免 mermaid/math/table 各 parse 一次。
 */

import type { Text } from '@codemirror/state'
import { findFencedCodeSpans, type FencedCodeSpan } from '@notefast/core'

const cache = new WeakMap<Text, FencedCodeSpan[]>()

export function fencedCodeSpansIn(doc: Text): FencedCodeSpan[] {
  let spans = cache.get(doc)
  if (!spans) {
    spans = findFencedCodeSpans(doc.toString())
    cache.set(doc, spans)
  }
  return spans
}

export function offsetInFencedCode(spans: FencedCodeSpan[], offset: number): boolean {
  return spans.some((s) => offset >= s.from && offset < s.to)
}
