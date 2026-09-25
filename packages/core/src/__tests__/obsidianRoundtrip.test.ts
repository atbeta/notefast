/**
 * Obsidian 语法往返（RFC 0003 / 计划 V-304）：解析不丢字、不合并，序列化后逐字节还原。
 *
 * 唯一允许的归一化是独占行 `$$…$$` → ```math 围栏（设计如此：块仍是独立 code 块，
 * 语言标记 math，见 markdown/displayMath.ts）。
 */

import { describe, expect, test } from 'bun:test'
import { blocksToMarkdown, parseMarkdownToBlocks } from '../markdown'
import { inputsToOrderedBlocks } from '../markdown/semantics'

function roundTrip(markdown: string): string {
  return blocksToMarkdown(inputsToOrderedBlocks(parseMarkdownToBlocks(markdown, 'nb')))
}

function blockTypes(markdown: string): string[] {
  return parseMarkdownToBlocks(markdown, 'nb').map((b) => b.type)
}

describe('Obsidian 语法往返：callout', () => {
  const cases: Array<[string, string]> = [
    ['首行标题 + 空行分段', '> [!note] 标题\n> 内容一\n>\n> 内容二\n'],
    ['折叠标记', '> [!warning]- 折叠\n> 内容\n'],
    ['仅标题', '> [!note] 只有标题\n'],
    ['含列表（此前会被丢掉）', '> [!tip] 提示\n> - 项一\n> - 项二\n'],
    ['含代码围栏（此前会被丢掉）', '> [!warning] 代码\n> ```js\n> const a = 1\n> ```\n'],
    ['含表格（此前会被丢掉）', '> [!info] 表\n> | a | b |\n> | - | - |\n> | 1 | 2 |\n'],
    ['嵌套 callout（此前会被丢掉）', '> [!note] 外层\n> > [!tip] 内层\n> > 内容\n'],
    ['连续两个 callout', '> [!note] 一\n> a\n\n> [!tip] 二\n> b\n'],
    ['普通多段引用', '> 第一行\n> 第二行\n\n> 另一块\n'],
  ]

  for (const [name, markdown] of cases) {
    test(name, () => {
      expect(roundTrip(markdown)).toBe(markdown)
    })
  }

  test('复杂引用整体是一个 quote 块，不再把内容拆丢', () => {
    expect(blockTypes('> [!tip] 提示\n> - 项一\n> - 项二\n')).toEqual(['quote'])
    expect(blockTypes('> [!note] 外层\n> > [!tip] 内层\n')).toEqual(['quote'])
  })
})

describe('Obsidian 语法往返：注释 / 块 id / 嵌入 / 数学', () => {
  const exact: Array<[string, string]> = [
    ['行内注释', '文字 %%注释%% 文字\n'],
    ['整段注释', '%%这是注释%%\n\n正文\n'],
    ['多行注释', '%%\n多行注释\n第二行\n%%\n'],
    ['段末块 id', '一段话 ^abc123\n'],
    ['标题块 id', '## 标题 ^abc\n'],
    ['列表项块 id', '- 项 ^abc\n'],
    ['块嵌入', '![[整篇嵌入]]\n\n正文\n'],
    ['带尺寸的图片嵌入', '![[img.png|200]]\n'],
    ['列表项内嵌入', '- 项目 ![[img.png]]\n'],
    ['dataview 查询块', '```dataview\nTABLE file.name\nFROM #tag\n```\n'],
    ['行内数学', '行内 $x$ 公式\n'],
    ['引用内独占行 $$', '> [!note] 公式\n> $$\n> x=1\n> $$\n'],
  ]

  for (const [name, markdown] of exact) {
    test(name, () => {
      expect(roundTrip(markdown)).toBe(markdown)
    })
  }

  test('独占行 $$ → math 围栏（唯一允许的归一化，二次往返稳定）', () => {
    const source = '$$\nE = mc^2\n$$\n\n正文\n'
    const normalized = '```math\nE = mc^2\n```\n\n正文\n'
    expect(roundTrip(source)).toBe(normalized)
    expect(roundTrip(normalized)).toBe(normalized)
    // 块结构：独立 code 块 + 段落
    expect(blockTypes(source)).toEqual(['code', 'paragraph'])
  })

  test('单行 $$x$$ 不提升为块，保持段落原文', () => {
    expect(roundTrip('单行 $$x$$ 公式\n')).toBe('单行 $$x$$ 公式\n')
  })

  test('块 id 剥离进 properties，序列化还原到行尾', () => {
    const blocks = parseMarkdownToBlocks('一段话 ^abc123\n\n- 列表项 ^l1\n', 'nb')
    expect(blocks[0]!.content).toBe('一段话')
    expect(blocks[0]!.properties?.obsidian_block_id).toBe('abc123')
    expect(blocks[1]!.content).toBe('列表项')
    expect(blocks[1]!.properties?.obsidian_block_id).toBe('l1')
    // 不是块 id 的写法不动（必须空格 + ^ + 字母数字连字符结尾）
    expect(parseMarkdownToBlocks('公式 a^2 与 b ^ 结尾\n', 'nb')[0]!.properties?.obsidian_block_id).toBeUndefined()
  })
})
