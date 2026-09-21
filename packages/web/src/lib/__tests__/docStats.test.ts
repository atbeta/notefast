/**
 * 文档统计口径契约。
 *
 * 两件事必须钉住：
 *  1. **口径**——markdown 语法、链接地址、图片 alt 不算「字」；CJK 按字、西文按词。
 *     旧实现按 `content.length` 累加源码，链接多的一篇能虚高几十倍。
 *  2. **等价性**——统计结果必须等于渲染层真正吐出来的文本（`renderInline` 的产物）。
 *     这是「统计口径 = 渲染口径」的机器可验版本；本文件依赖 BlockRenderer 里
 *     真实的行内渲染，任何一边改动而另一边没跟上，这里会红。
 */
import { describe, test, expect } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BlockType, type Block } from '@notefast/core'
import { renderInline } from '../../components/BlockRenderer'
import { renderedInlineText } from '../inlineMarkdown'
import {
  countDocStats,
  hasRenderableContent,
  readingMinutes,
  renderedBlockText,
  statsFromRenderedText,
} from '../docStats'

let seq = 0
function block(type: BlockType, content: string, children: Block[] = []): Block {
  return {
    id: `b${++seq}`,
    notebook_id: 'nb',
    parent_id: 'doc',
    root_id: 'doc',
    type,
    content,
    properties: {},
    tags: [],
    status: 'note',
    ai_exclude: false,
    sort: ++seq,
    level: 1,
    created_at: '',
    updated_at: '',
    children,
  }
}

/** 把 renderInline 的产物渲染成 HTML，再去标签取上屏文本（<br> → 换行）。 */
function htmlText(text: string): string {
  const html = renderToStaticMarkup(createElement('p', null, renderInline(text)))
  return html
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

describe('renderedInlineText 与真实渲染等价', () => {
  const corpus = [
    '一段普通的中文正文',
    '这是**加粗**的字',
    '这是*斜体*的字',
    '这是~~删除线~~的字',
    '行内 `const a = 1` 代码',
    '见[文档](https://example.com/a/b)了解',
    '见 https://example.com/x,',
    '混排 RAG（检索增强生成）with English words',
    '第一行\n第二行',
    '行尾两空格硬换行  \n第二行',
    '**粗**里有 `code`',
  ]

  for (const text of corpus) {
    test(`等价：${text.replace(/\n/g, '\\n')}`, () => {
      expect(renderedInlineText(text)).toBe(htmlText(text))
    })
  }
})

describe('统计口径', () => {
  test('链接只算文字，地址不计——这是旧实现虚高的主因', () => {
    const stats = statsFromRenderedText(renderedInlineText('[文档](https://example.com/a/very/long/path)'))
    expect(stats.words).toBe(2)
    expect(stats.chars).toBe(2)
  })

  test('markdown 语法标记不计，图片不计', () => {
    expect(renderedInlineText('**重点**')).toBe('重点')
    expect(renderedInlineText('![截图](/api/v1/assets/abc)')).toBe('')
    expect(renderedInlineText('`code`')).toBe('code')
  })

  test('行内公式算 tex（KaTeX 渲出来的就是它）', () => {
    expect(renderedInlineText('设 $x^2$ 为面积')).toBe('设 x^2 为面积')
  })

  test('裸 URL 整段计入（它上屏就是这些字符）', () => {
    expect(renderedInlineText('见 https://a.com/x,')).toBe('见 https://a.com/x,')
  })

  test('CJK 按字、西文按词，缩写与连字符各算一个词', () => {
    const s = statsFromRenderedText('中文三个字 don\u2019t state-of-the-art')
    expect(s.cjk).toBe(5)
    // don’t 与 state-of-the-art 各算一个词（撇号/连字符不断词）
    expect(s.latinWords).toBe(2)
    expect(s.words).toBe(7)
  })

  test('字符数分计/不计空白，行数只数非空行', () => {
    const s = statsFromRenderedText('ab cd\nef')
    expect(s.charsWithSpaces).toBe(8)
    expect(s.chars).toBe(6)
    expect(s.lines).toBe(2)
  })
})

describe('块级口径', () => {
  test('document 块的 content 是标题不是正文，不计入', () => {
    const doc = block(BlockType.Document, '这是文档标题', [block(BlockType.Paragraph, '正文两个字')])
    expect(countDocStats(doc).words).toBe(5)
  })

  test('代码块原样计入，代码里的 * 与 # 不当语法剥', () => {
    const code = block(BlockType.Code, '**不是加粗**\n# 不是标题')
    expect(renderedBlockText(code)).toBe('**不是加粗**\n# 不是标题')
  })

  test('表格丢掉分隔行与管道符，逐格取上屏文本', () => {
    const table = block(BlockType.Table, '| 名称 | 值 |\n| --- | ---: |\n| 甲 | `1` |')
    expect(renderedBlockText(table)).toBe('名称 值\n甲 1')
  })

  test('子块参与统计（标题下的段落、列表项都在 children 里）', () => {
    const doc = block(BlockType.Document, '标题', [
      block(BlockType.Heading, '小节'),
      block(BlockType.List, '', [block(BlockType.ListItem, '第一项'), block(BlockType.ListItem, '第二项')]),
    ])
    // 小节 2 + 第一项 3 + 第二项 3；文档标题不计
    expect(countDocStats(doc).words).toBe(8)
  })

  test('空文档统计为零，null 不抛', () => {
    expect(countDocStats(block(BlockType.Document, '标题')).words).toBe(0)
    expect(countDocStats(null).words).toBe(0)
  })

  test('空态判据不跟字数走：只有图片的笔记字数为 0，但不是空文档', () => {
    const onlyImage = block(BlockType.Document, '标题', [block(BlockType.Paragraph, '![截图](/api/v1/assets/abc)')])
    expect(countDocStats(onlyImage).words).toBe(0)
    expect(hasRenderableContent(onlyImage)).toBe(true)
    expect(hasRenderableContent(block(BlockType.Document, '标题'))).toBe(false)
    expect(hasRenderableContent(block(BlockType.Document, '标题', [block(BlockType.Paragraph, '  ')]))).toBe(false)
  })
})

describe('阅读时长', () => {
  test('空文档为 0，非空至少 1 分钟', () => {
    expect(readingMinutes(statsFromRenderedText(''))).toBe(0)
    expect(readingMinutes(statsFromRenderedText('短'))).toBe(1)
  })

  test('中文 300 字/分、西文 200 词/分分别计算', () => {
    expect(readingMinutes(statsFromRenderedText('中'.repeat(600)))).toBe(2)
    expect(readingMinutes(statsFromRenderedText('word '.repeat(400)))).toBe(2)
  })
})
