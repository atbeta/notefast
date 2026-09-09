/**
 * Markdown → blocks（mdast 并行实现）
 *
 * 默认保存路径与 `parseMarkdownToBlocks` 均走本实现。
 * 映射目标是现行产品语义（软换行保 \n、Setext 当段落、水平线当 --- paragraph），
 * 不是完整 CommonMark 作业。独占行 $$ 在进 mdast 前改写成 ```math（不引入 remark-math）。
 */

import { stripDocFrontmatter } from '../frontmatter'
import { BlockType } from '../types'
import type { CreateBlockInput } from '../types'
import { rewriteClosedExclusiveDollarMath } from './displayMath'
import { findMdastFencedCodeSpans } from './fencedCode'
import { fromNoteFastMarkdown } from './fromMarkdown'

type MdNode = {
  type: string
  value?: string
  depth?: number
  lang?: string | null
  ordered?: boolean | null
  checked?: boolean | null
  url?: string | null
  alt?: string | null
  title?: string | null
  children?: MdNode[]
  position?: {
    start: { offset?: number }
    end: { offset?: number }
  }
}

/** 块在正文中的源码区间 `[start, end)`（相对已剥离 frontmatter 的 body） */
export interface BlockSpan {
  start: number
  end: number
}

export interface ParsedBlocksWithSpans {
  blocks: CreateBlockInput[]
  /** 与 blocks 同序；null = 该块没有可用源码区间 */
  spans: Array<BlockSpan | null>
}

export function parseMarkdownToBlocksMdast(markdown: string, notebookId: string): CreateBlockInput[] {
  return parseMarkdownToBlocksWithSpans(markdown, notebookId).blocks
}

export interface ParseWithSpansOptions {
  /**
   * 传入的文本已剥离 frontmatter（vault ingest / 写回手里就是 body）。
   * true 时不再剥一次 —— 否则正文本身形如 frontmatter 时会被二次剥离，偏移全错。
   */
  bodyOnly?: boolean
}

/**
 * 与 `parseMarkdownToBlocksMdast` 同结果，额外返回每个块的源码区间（RFC 0003 阶段 C）。
 *
 * 偏移取「块首行行首 → 块末行行尾」：`$$…$$` 会在进 mdast 前被改写成 ```math（长度变化），
 * 直接用 mdast 的字符偏移会错位；改写只替换整行内容、不增删行，因此行号在 body 与改写文本间
 * 一一对应，按行换算即可拿到原始偏移。
 */
export function parseMarkdownToBlocksWithSpans(
  markdown: string,
  notebookId: string,
  opts: ParseWithSpansOptions = {},
): ParsedBlocksWithSpans {
  const body = opts.bodyOnly ? markdown.replace(/^\uFEFF/, '') : stripDocFrontmatter(markdown).body
  if (body === '') return { blocks: [], spans: [] }

  const occupied = findMdastFencedCodeSpans(body)
  const doc = rewriteClosedExclusiveDollarMath(body, occupied)
  const tree = fromNoteFastMarkdown(doc) as MdNode

  const docLineStarts = lineStarts(doc)
  const bodyLines = body.split('\n')
  const bodyLineStarts = lineStarts(body)

  const out: CreateBlockInput[] = []
  const spans: Array<BlockSpan | null> = []

  const spanOf = (node: MdNode): BlockSpan | null => {
    const s = node.position?.start.offset
    const e = node.position?.end.offset
    if (s == null || e == null || e <= s) return null
    const startLine = lineIndexAt(docLineStarts, s)
    const endLine = lineIndexAt(docLineStarts, e - 1)
    if (startLine == null || endLine == null || endLine >= bodyLines.length) return null
    return { start: bodyLineStarts[startLine]!, end: bodyLineStarts[endLine]! + bodyLines[endLine]!.length }
  }

  const push = (input: CreateBlockInput, node: MdNode | null): void => {
    out.push(input)
    spans.push(node ? spanOf(node) : null)
  }

  const walk = (nodes: MdNode[] | undefined, parentId: string | null): void => {
    if (!nodes) return
    for (const node of nodes) {
      switch (node.type) {
        case 'heading': {
          const id = crypto.randomUUID()
          push(makeInput(id, notebookId, parentId, BlockType.Heading, phrasingContent(node), {
            headingLevel: node.depth ?? 1,
          }), node)
          break
        }
        case 'paragraph': {
          const id = crypto.randomUUID()
          push(makeInput(id, notebookId, parentId, BlockType.Paragraph, phrasingContent(node), {}), node)
          break
        }
        case 'blockquote': {
          const id = crypto.randomUUID()
          push(makeInput(id, notebookId, parentId, BlockType.Quote, quoteContent(node), {}), node)
          break
        }
        case 'code': {
          const id = crypto.randomUUID()
          const lang = (node.lang ?? '').trim()
          push(
            makeInput(id, notebookId, parentId, BlockType.Code, node.value ?? '', lang ? { language: lang } : {}),
            node,
          )
          break
        }
        case 'table': {
          const id = crypto.randomUUID()
          push(makeInput(id, notebookId, parentId, BlockType.Table, sliceTrimEnd(node, doc), {}), node)
          break
        }
        case 'thematicBreak': {
          const id = crypto.randomUUID()
          push(makeInput(id, notebookId, parentId, BlockType.Paragraph, '---', {}), node)
          break
        }
        case 'html': {
          const id = crypto.randomUUID()
          push(makeInput(id, notebookId, parentId, BlockType.Paragraph, node.value ?? '', {}), node)
          break
        }
        case 'list': {
          walkListItems(node, parentId, notebookId, doc, push, walk)
          break
        }
        case 'definition':
        case 'footnoteDefinition': {
          const id = crypto.randomUUID()
          push(
            makeInput(id, notebookId, parentId, BlockType.Paragraph, sliceTrimEnd(node, doc), {
              markdownFallback: true,
              markdownNodeType: node.type,
            }),
            node,
          )
          break
        }
        default: {
          if (node.children?.length) walk(node.children, parentId)
          else if (node.value) {
            const id = crypto.randomUUID()
            push(
              makeInput(id, notebookId, parentId, BlockType.Paragraph, node.value, {
                markdownFallback: true,
                markdownNodeType: node.type,
              }),
              node,
            )
          }
        }
      }
    }
  }

  walk(tree.children, null)
  return { blocks: out, spans }
}

/** 每行起始偏移；长度 = 行数 + 1（末尾多一个 = 文本长度） */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

/** 二分查找 offset 所在行（最后一个 start <= offset） */
function lineIndexAt(starts: number[], offset: number): number | null {
  if (offset < 0) return null
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

function makeInput(
  id: string,
  notebookId: string,
  parentId: string | null,
  type: CreateBlockInput['type'],
  content: string,
  properties: Record<string, unknown>,
): CreateBlockInput {
  return {
    id,
    notebook_id: notebookId,
    parent_id: parentId,
    type,
    content,
    properties,
    sort: 0,
  }
}

function walkListItems(
  list: MdNode,
  parentId: string | null,
  notebookId: string,
  doc: string,
  push: (input: CreateBlockInput, node: MdNode | null) => void,
  walk: (nodes: MdNode[] | undefined, parentId: string | null) => void,
): void {
  const ordered = list.ordered === true
  for (const item of list.children ?? []) {
    if (item.type !== 'listItem') continue
    const id = crypto.randomUUID()
    const { text, nested } = splitListItem(item)
    push(makeInput(id, notebookId, parentId, BlockType.ListItem, text, listItemProps(item, ordered, doc)), item)
    walk(nested, id)
  }
}

function splitListItem(item: MdNode): { text: string; nested: MdNode[] } {
  const nested: MdNode[] = []
  const textParts: string[] = []
  for (const child of item.children ?? []) {
    if (child.type === 'list') nested.push(child)
    else if (child.type === 'paragraph') textParts.push(phrasingContent(child))
    else if (child.type === 'code' || child.type === 'blockquote' || child.type === 'heading' || child.type === 'table') {
      nested.push(child)
    } else if (child.type === 'html') {
      textParts.push(child.value ?? '')
    }
  }
  return { text: textParts.join('\n'), nested }
}

function listItemProps(item: MdNode, ordered: boolean, doc: string): Record<string, unknown> {
  const properties: Record<string, unknown> = { ordered }
  if (!ordered) {
    const marker = readUnorderedMarker(item, doc)
    if (marker) properties.marker = marker
  }
  if (item.checked === true || item.checked === false) {
    properties.task = true
    properties.checked = item.checked
  }
  return properties
}

function readUnorderedMarker(item: MdNode, doc: string): string | undefined {
  const start = item.position?.start.offset
  if (start == null) return undefined
  const snippet = doc.slice(start, start + 8)
  const match = snippet.match(/^\s*([-*+])\s/)
  return match?.[1]
}

function quoteContent(node: MdNode): string {
  const parts: string[] = []
  for (const child of node.children ?? []) {
    if (child.type === 'paragraph') parts.push(phrasingContent(child))
    else if (child.type === 'html') parts.push(child.value ?? '')
  }
  return parts.join('\n\n')
}

/**
 * 行内还原为 Markdown 字符串。blockquote 续行的源码切片会带上 `>`，不能直接 slice。
 * 图片/链接/加粗等用 mdast 节点还原，对齐现行「行内存原文」契约。
 */
function phrasingContent(node: MdNode): string {
  return (node.children ?? []).map(serializePhrasing).join('')
}

function serializePhrasing(node: MdNode): string {
  switch (node.type) {
    case 'text':
      return node.value ?? ''
    case 'strong':
      return `**${(node.children ?? []).map(serializePhrasing).join('')}**`
    case 'emphasis':
      return `*${(node.children ?? []).map(serializePhrasing).join('')}*`
    case 'inlineCode':
      return `\`${node.value ?? ''}\``
    case 'break':
      return '\n'
    case 'image': {
      const alt = node.alt ?? ''
      const url = node.url ?? ''
      const title = node.title ? ` "${node.title}"` : ''
      return `![${alt}](${url}${title})`
    }
    case 'link': {
      const text = (node.children ?? []).map(serializePhrasing).join('')
      const url = node.url ?? ''
      const title = node.title ? ` "${node.title}"` : ''
      return `[${text}](${url}${title})`
    }
    case 'html':
      return node.value ?? ''
    default:
      if (node.children?.length) return node.children.map(serializePhrasing).join('')
      return node.value ?? ''
  }
}

function sliceTrimEnd(node: MdNode, doc: string): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start == null || end == null) return node.value ?? ''
  return doc.slice(start, end).replace(/\n+$/, '')
}
