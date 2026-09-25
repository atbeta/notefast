/**
 * 带源码区间的解析（RFC 0003 阶段 C）：区间必须能原样切回源码，
 * 且块序列与 `parseMarkdownToBlocks` 完全一致。
 */

import { describe, expect, test } from 'bun:test'
import { parseMarkdownToBlocks, parseMarkdownToBlocksWithSpans } from '../markdown'

const FIXTURE = [
  '第一段 *斜体* 与 _斜体_',
  '',
  '> [!note] 提醒',
  '> 细节一',
  '>',
  '> 细节二',
  '',
  '%%私密注释%%',
  '',
  '',
  '',
  '- 列表项 A',
  '  - 嵌套 B',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '尾段 ^abc123',
  '',
  '![[img.png]]',
  '',
].join('\n')

function topTexts(markdown: string): string[] {
  const { blocks, spans } = parseMarkdownToBlocksWithSpans(markdown, 'nb')
  return blocks
    .map((block, i) => ({ block, span: spans[i] }))
    .filter(({ block }) => block.parent_id === null)
    .map(({ span }) => (span ? markdown.slice(span.start, span.end) : ''))
}

describe('parseMarkdownToBlocksWithSpans', () => {
  test('顶层块的区间切片等于源码原文（含 $$ 改写、callout、列表项、嵌入）', () => {
    const texts = topTexts(FIXTURE)
    expect(texts).toContain('第一段 *斜体* 与 _斜体_')
    expect(texts).toContain('> [!note] 提醒\n> 细节一\n>\n> 细节二')
    expect(texts).toContain('%%私密注释%%')
    // 顶层列表项连同其嵌套子项是一个块（子项是它的 child），区间覆盖整段
    expect(texts).toContain('- 列表项 A\n  - 嵌套 B')
    expect(texts).toContain('$$\nE = mc^2\n$$')
    expect(texts).toContain('尾段 ^abc123')
    expect(texts).toContain('![[img.png]]')
    expect(texts.every((t) => t.length > 0)).toBe(true)
  })

  test('区间首尾与源码对齐：拼接后覆盖全文（空行留在缝隙里）', () => {
    const { blocks, spans } = parseMarkdownToBlocksWithSpans(FIXTURE, 'nb')
    const topSpans = blocks
      .map((block, i) => ({ block, span: spans[i] }))
      .filter(({ block }) => block.parent_id === null)
      .map(({ span }) => span!)
    for (let i = 1; i < topSpans.length; i++) {
      expect(topSpans[i]!.start).toBeGreaterThanOrEqual(topSpans[i - 1]!.end)
    }
    // 首块前的空白 + 末块后的空白都在缝隙里，且不含块内容
    expect(FIXTURE.slice(0, topSpans[0]!.start)).toBe('')
    expect(FIXTURE.slice(topSpans[topSpans.length - 1]!.end)).toBe('\n')
  })

  test('块序列与 parseMarkdownToBlocks 完全一致', () => {
    const plain = parseMarkdownToBlocks(FIXTURE, 'nb').map((b) => [b.type, b.content, b.parent_id ? 'child' : 'top'])
    const spanned = parseMarkdownToBlocksWithSpans(FIXTURE, 'nb').blocks.map((b) => [
      b.type,
      b.content,
      b.parent_id ? 'child' : 'top',
    ])
    expect(spanned).toEqual(plain)
  })

  test('bodyOnly：正文本身形如 frontmatter 时不再二次剥离', () => {
    const body = '---\ntitle: 这是正文\n---\n真的正文\n'
    const stripped = parseMarkdownToBlocksWithSpans(body, 'nb')
    // 默认按整篇处理 → 首段 YAML 被当 frontmatter 剥掉
    expect(stripped.blocks.map((b) => b.content)).toEqual(['真的正文'])

    const kept = parseMarkdownToBlocksWithSpans(body, 'nb', { bodyOnly: true })
    expect(kept.blocks.map((b) => b.content)).toEqual(['---', 'title: 这是正文', '---', '真的正文'])
    const first = kept.spans[0]!
    expect(body.slice(first.start, first.end)).toBe('---')
  })
})
