/**
 * BlockRenderer.renderInline — 软换行渲染契约
 *
 * 段落内容里的单个 \n（CommonMark soft break）渲染为 <br>，而不是被 HTML
 * 折叠成空格 —— 对齐 Obsidian 默认 / GitHub 评论行为。存储与解析仍是
 * CommonMark（空行分段、行尾两空格硬换行），这里只钉显示层。
 */
import { describe, test, expect } from 'bun:test'
import { isValidElement, type ReactNode } from 'react'
import { renderInline } from '../BlockRenderer'

function brCount(nodes: ReactNode[]): number {
  return nodes.filter((n) => isValidElement(n) && n.type === 'br').length
}

function textParts(nodes: ReactNode[]): string[] {
  return nodes.filter((n): n is string => typeof n === 'string')
}

describe('renderInline 软换行', () => {
  test('单个 \\n → <br>，文本分两段', () => {
    const nodes = renderInline('第一行\n第二行')
    expect(brCount(nodes)).toBe(1)
    expect(textParts(nodes)).toEqual(['第一行', '第二行'])
  })

  test('无换行时不产生 <br>', () => {
    const nodes = renderInline('一行到底')
    expect(brCount(nodes)).toBe(0)
    expect(textParts(nodes)).toEqual(['一行到底'])
  })

  test('行尾两空格硬换行同样渲染为 <br>（标准 Markdown 行为是其子集）', () => {
    const nodes = renderInline('abc  \ndef')
    expect(brCount(nodes)).toBe(1)
    expect(textParts(nodes)).toEqual(['abc  ', 'def'])
  })

  test('换行两侧的行内标记照常解析', () => {
    const nodes = renderInline('**粗**\n*斜*')
    expect(brCount(nodes)).toBe(1)
    const tags = nodes.filter(isValidElement).map((n) => n.type)
    expect(tags).toContain('strong')
    expect(tags).toContain('em')
  })

  test('连续多行 → 对应数量 <br>', () => {
    const nodes = renderInline('a\nb\nc')
    expect(brCount(nodes)).toBe(2)
    expect(textParts(nodes)).toEqual(['a', 'b', 'c'])
  })
})
