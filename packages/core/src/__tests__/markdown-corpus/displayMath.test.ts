/**
 * A-4 独占行 $$：扫描、保存映射、围栏预览区间。不引入 remark-math。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { parseMarkdownToBlocks, parseMarkdownToBlocksLegacy, blocksToMarkdown } from '../../markdown'
import { findExclusiveDollarMathSpans } from '../../markdown/displayMath'
import { findFencedCodeSpans, findMdastFencedCodeSpans } from '../../markdown/fencedCode'
import { parseMarkdownToBlocksMdast } from '../../markdown/parseMdast'
import { inputsToOrderedBlocks, toSemanticForest } from '../../markdown/semantics'
import { EXTENSION_FIXTURES } from './contract'
import { fixturePath, readFixtureFile } from './loadFixture'

function shape(markdown: string) {
  return toSemanticForest(parseMarkdownToBlocksMdast(markdown, 'nb'))
}

describe('独占行 $$ corpus 文件齐全', () => {
  test('每个扩展 id 都有 .md', () => {
    for (const id of EXTENSION_FIXTURES) {
      expect(existsSync(fixturePath('extension', `${id}.md`))).toBe(true)
    }
  })
})

describe('findExclusiveDollarMathSpans', () => {
  test('闭合对：language=math，value 为内部文本', () => {
    const md = readFixtureFile('extension', 'dollar-display.md')
    const spans = findExclusiveDollarMathSpans(md, [])
    expect(spans).toHaveLength(1)
    expect(spans[0]?.language).toBe('math')
    expect(spans[0]?.closed).toBe(true)
    expect(spans[0]?.value).toBe('E = mc^2')
  })

  test('未闭合不产出 span（不吞后文）', () => {
    const md = readFixtureFile('extension', 'dollar-unclosed.md')
    expect(findExclusiveDollarMathSpans(md, [])).toEqual([])
  })

  test('代码围栏内的 $$ 不识别', () => {
    const md = readFixtureFile('extension', 'dollar-inside-code.md')
    const occupied = findMdastFencedCodeSpans(md)
    expect(findExclusiveDollarMathSpans(md, occupied)).toEqual([])
  })
})

describe('parseMarkdownToBlocksMdast：独占行 $$', () => {
  test('dollar-display → code/math，导出仍是 ```math', () => {
    const md = readFixtureFile('extension', 'dollar-display.md')
    const forest = shape(md)
    expect(forest).toEqual([
      { type: 'paragraph', content: '前段', properties: {}, children: [] },
      { type: 'code', content: 'E = mc^2', properties: { language: 'math' }, children: [] },
      { type: 'paragraph', content: '后段', properties: {}, children: [] },
    ])
    const exported = blocksToMarkdown(inputsToOrderedBlocks(parseMarkdownToBlocksMdast(md, 'nb')))
    expect(exported).toContain('```math')
    expect(exported).toContain('E = mc^2')
    expect(shape(exported)).toEqual(forest)
  })

  test('未闭合 $$ 保持段落，不提升为 code', () => {
    const forest = shape(readFixtureFile('extension', 'dollar-unclosed.md'))
    expect(forest.every((n) => n.type !== 'code')).toBe(true)
    expect(forest.some((n) => n.content.includes('$$'))).toBe(true)
    expect(forest.some((n) => n.content.includes('const x = 1'))).toBe(true)
  })

  test('单行 $$x^2$$ 不提升为块级公式', () => {
    const forest = shape(readFixtureFile('extension', 'dollar-inline-not-display.md'))
    expect(forest).toEqual([
      { type: 'paragraph', content: '单行 $$x^2$$ 不是块级公式。', properties: {}, children: [] },
    ])
  })

  test('围栏内 $$ 仍是普通 code', () => {
    const forest = shape(readFixtureFile('extension', 'dollar-inside-code.md'))
    expect(forest).toHaveLength(1)
    expect(forest[0]?.type).toBe('code')
    expect(forest[0]?.content).toContain('$$')
    expect(forest[0]?.content).toContain('E = mc^2')
    expect(forest[0]?.properties.language).toBe('md')
  })

  test('货币 $5-$10 仍是段落', () => {
    const forest = shape(readFixtureFile('extension', 'dollar-currency.md'))
    expect(forest).toEqual([
      { type: 'paragraph', content: '价格在 $5-$10 之间，不是公式。', properties: {}, children: [] },
    ])
  })

  test('公式内非独占行 $$ 留在 content', () => {
    const forest = shape(readFixtureFile('extension', 'dollar-inner-dollar.md'))
    expect(forest).toEqual([
      { type: 'code', content: 'x = $$ y', properties: { language: 'math' }, children: [] },
    ])
  })

  test('$$ 之后的表格切片不被改写位移打坏', () => {
    const forest = shape(readFixtureFile('extension', 'dollar-then-table.md'))
    expect(forest[0]).toEqual({
      type: 'code',
      content: 'a^2',
      properties: { language: 'math' },
      children: [],
    })
    expect(forest[1]?.type).toBe('table')
    expect(forest[1]?.content).toContain('| A | B |')
    expect(forest[1]?.content).toContain('| 1 | 2 |')
  })

  test('手写 parser 仍把 $$ 当段落（兼容层不加新方言）', () => {
    const md = readFixtureFile('extension', 'dollar-display.md')
    const legacy = toSemanticForest(parseMarkdownToBlocksLegacy(md, 'nb'))
    expect(legacy.every((n) => n.type !== 'code')).toBe(true)
    expect(toSemanticForest(parseMarkdownToBlocks(md, 'nb'))).toEqual(shape(md))
  })
})

describe('findFencedCodeSpans 合并 $$', () => {
  test('闭合 $$ 出现在围栏列表里，未闭合不出现', () => {
    const closed = readFixtureFile('extension', 'dollar-display.md')
    const math = findFencedCodeSpans(closed).filter((s) => s.language === 'math' && s.closed)
    expect(math).toHaveLength(1)
    expect(math[0]?.value).toBe('E = mc^2')

    const open = readFixtureFile('extension', 'dollar-unclosed.md')
    expect(findFencedCodeSpans(open).filter((s) => s.language === 'math')).toEqual([])
  })
})
