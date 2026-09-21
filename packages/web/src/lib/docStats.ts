/**
 * 文档统计：字数 / 字符数 / 行数 / 预计阅读时长。
 *
 * 口径（对齐 Typora / Word 的读者直觉，也是 lector core/stats.ts 的同一套口径）：
 * - **字数** = CJK 字符数（含中文标点：中文文档里标点也占版面）+ 西文单词数。
 *   中文按字计、西文按词计，混排相加才是用户心里那个数。
 * - **字符数** = 「上屏文本」的字符数（分计 / 不计空白）。markdown 语法
 *   （`**`、`[]()`、`#`、代码围栏、URL）不计——用户问的是「这篇内容多少字」，
 *   不是「源码多少字节」。旧实现按 `content.length` 累加，一篇链接列表能虚高几十倍。
 * - **行数** = 非空行数。
 *
 * 实现不走 mdast，也不自己再写一份行内语法：**直接复用渲染层的行内 token**
 * （lib/inlineMarkdown.ts 的 renderedInlineText），所以「统计口径 = 渲染口径」，
 * 与 reader 上肉眼看到的字符一致。改行内语法只需改那一处。
 *
 * 纯函数、无 DOM：可在 bun test 里穷举（见 lib/__tests__/docStats.test.ts，
 * 其中包含与 renderInline 真实渲染结果的等价性断言）。
 */
import { BlockType, type Block } from '@notefast/core'
import { renderedInlineText } from './inlineMarkdown'

/** CJK 统一表意文字 + 假名 + 谚文 + 全角标点（U+3000–303F / U+FF00–FFEF）。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g

/** 西文词：字母数字串，内部可含撇号/连字符——don't、state-of-the-art 各算一个词。 */
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu

/** 阅读速度：中文按字、西文按词，两者分开估再相加（不要用一个混排中位数糊过去）。 */
const CJK_PER_MINUTE = 300
const LATIN_WORDS_PER_MINUTE = 200

export interface DocStats {
  /** CJK 字符数 + 西文单词数（用户理解的「字数」）。 */
  words: number
  /** 其中 CJK 字符数（含中文标点）。 */
  cjk: number
  /** 其中西文单词数。 */
  latinWords: number
  /** 上屏文本去空白后的字符数。 */
  chars: number
  /** 上屏文本总字符数（含空白与换行）。 */
  charsWithSpaces: number
  /** 非空行数。 */
  lines: number
}

export const EMPTY_DOC_STATS: DocStats = {
  words: 0,
  cjk: 0,
  latinWords: 0,
  chars: 0,
  charsWithSpaces: 0,
  lines: 0,
}

/**
 * 表格块的上屏文本：丢掉 GFM 分隔行（`| --- | --- |`）与管道符，逐格取上屏文本。
 *
 * 刻意不 import 编辑器的 parseTable（lib 不依赖 components，是本仓库既有分层）：
 * 这里只求总字数，按未转义管道切格足以——转义管道 `\|` 会少算一个字符，
 * 属于可接受误差；而「少算一个 `|`」远好过把整张表格的分隔行算成正文。
 */
function tableRenderedText(source: string): string {
  const out: string[] = []
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // 分隔行：去掉管道、空格、冒号后只剩短横线
    if (/^[|\s:-]+$/.test(trimmed) && trimmed.includes('-')) continue
    const cells = trimmed
      .replace(/(^|[^\\])\|/g, '$1\u0000')
      .split('\u0000')
      .map((c) => c.trim())
      .filter((c) => c !== '')
    out.push(cells.map(renderedInlineText).join(' '))
  }
  return out.join('\n')
}

/**
 * 单个块的上屏文本。
 *
 * - `document` 块的 content 是**文档标题**而非正文（见 core types.ts 的关键约定）：
 *   不计入——否则空文档的标题会让「isEmpty」永远为假，字数也白多一个标题。
 * - `code` 块原样计入：代码就是它的正文，里面的 `*`、`#` 都是代码，不是语法。
 * - 其余块按行内 Markdown 取上屏文本。
 */
export function renderedBlockText(block: Block): string {
  const content = block.content ?? ''
  if (block.type === BlockType.Document) return ''
  if (block.type === BlockType.Code) return content
  if (block.type === BlockType.Table) return tableRenderedText(content)
  return renderedInlineText(content)
}

/** 整棵块树的上屏文本（块之间以换行相接）。 */
export function renderedDocText(root: Block): string {
  const parts: string[] = []
  const walk = (b: Block) => {
    const text = renderedBlockText(b)
    if (text) parts.push(text)
    for (const child of b.children ?? []) walk(child)
  }
  walk(root)
  return parts.join('\n')
}

/** 从「上屏文本」算统计量。 */
export function statsFromRenderedText(rendered: string): DocStats {
  // 西文取词前先摘掉 CJK（已按字计过），否则一串连续汉字会被当成一个词。
  const cjk = (rendered.match(CJK) ?? []).length
  const latinWords = (rendered.replace(CJK, ' ').match(WORD) ?? []).length
  return {
    words: cjk + latinWords,
    cjk,
    latinWords,
    chars: rendered.replace(/\s/g, '').length,
    charsWithSpaces: rendered.length,
    lines: rendered.split('\n').filter((l) => l.trim() !== '').length,
  }
}

/** 统计一篇文档（阅读页 meta 行与编辑器状态行共用）。 */
export function countDocStats(root: Block | null | undefined): DocStats {
  if (!root) return EMPTY_DOC_STATS
  return statsFromRenderedText(renderedDocText(root))
}

/**
 * 文档是否「有内容」（阅读页的空态判定）。
 *
 * 刻意**不用 `words > 0`**：字数只统计上屏文本，而图片、Obsidian 嵌入这类块
 * 没有上屏文本却是实实在在的内容——一篇只有截图的笔记不该被判成空文档。
 * 判据沿用旧实现：除根块（document 的 content 是标题）外，任一块有非空 content。
 */
export function hasRenderableContent(root: Block | null | undefined): boolean {
  if (!root) return false
  const walk = (b: Block): boolean => {
    if (b.type !== BlockType.Document && (b.content ?? '').trim() !== '') return true
    return (b.children ?? []).some(walk)
  }
  return walk(root)
}

/**
 * 预计阅读时长（分钟，向上取整、至少 1；空文档为 0）。
 * 中文 300 字/分、西文 200 词/分分别计算后相加——混排时比单一中位数更准。
 */
export function readingMinutes(stats: DocStats): number {
  if (stats.words === 0) return 0
  const minutes = stats.cjk / CJK_PER_MINUTE + stats.latinWords / LATIN_WORDS_PER_MINUTE
  return Math.max(1, Math.ceil(minutes))
}
