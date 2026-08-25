/**
 * Markdown → blocks（mdast 并行实现）
 *
 * 默认保存路径仍走 markdown.ts 手写 parser。本模块只供对照测试与后续开关使用。
 * 映射目标是现行产品语义（软换行保 \n、Setext 当段落、水平线当 --- paragraph），
 * 不是完整 CommonMark 作业。
 */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table'
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item'
import { gfmTable } from 'micromark-extension-gfm-table'
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item'
import { stripDocFrontmatter } from '../frontmatter'
import { BlockType } from '../types'
import type { CreateBlockInput } from '../types'

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

export function parseMarkdownToBlocksMdast(markdown: string, notebookId: string): CreateBlockInput[] {
  const { body } = stripDocFrontmatter(markdown)
  if (body === '') return []

  const tree = fromMarkdown(body, {
    extensions: [
      { disable: { null: ['setextUnderline', 'codeIndented'] } },
      gfmTable(),
      gfmTaskListItem(),
    ],
    mdastExtensions: [gfmTableFromMarkdown(), gfmTaskListItemFromMarkdown()],
  }) as MdNode

  const out: CreateBlockInput[] = []

  const walk = (nodes: MdNode[] | undefined, parentId: string | null): void => {
    if (!nodes) return
    for (const node of nodes) {
      switch (node.type) {
        case 'heading': {
          const id = crypto.randomUUID()
          out.push(makeInput(id, notebookId, parentId, BlockType.Heading, phrasingContent(node), {
            headingLevel: node.depth ?? 1,
          }))
          break
        }
        case 'paragraph': {
          const id = crypto.randomUUID()
          out.push(makeInput(id, notebookId, parentId, BlockType.Paragraph, phrasingContent(node), {}))
          break
        }
        case 'blockquote': {
          const id = crypto.randomUUID()
          out.push(makeInput(id, notebookId, parentId, BlockType.Quote, quoteContent(node), {}))
          break
        }
        case 'code': {
          const id = crypto.randomUUID()
          const lang = (node.lang ?? '').trim()
          out.push(makeInput(id, notebookId, parentId, BlockType.Code, node.value ?? '', lang ? { language: lang } : {}))
          break
        }
        case 'table': {
          const id = crypto.randomUUID()
          out.push(makeInput(id, notebookId, parentId, BlockType.Table, sliceTrimEnd(node, body), {}))
          break
        }
        case 'thematicBreak': {
          const id = crypto.randomUUID()
          out.push(makeInput(id, notebookId, parentId, BlockType.Paragraph, '---', {}))
          break
        }
        case 'html': {
          const id = crypto.randomUUID()
          out.push(makeInput(id, notebookId, parentId, BlockType.Paragraph, node.value ?? '', {}))
          break
        }
        case 'list': {
          walkListItems(node, parentId, notebookId, body, out, walk)
          break
        }
        case 'definition':
        case 'footnoteDefinition': {
          const id = crypto.randomUUID()
          out.push(makeInput(id, notebookId, parentId, BlockType.Paragraph, sliceTrimEnd(node, body), {
            markdownFallback: true,
            markdownNodeType: node.type,
          }))
          break
        }
        default: {
          if (node.children?.length) walk(node.children, parentId)
          else if (node.value) {
            const id = crypto.randomUUID()
            out.push(makeInput(id, notebookId, parentId, BlockType.Paragraph, node.value, {
              markdownFallback: true,
              markdownNodeType: node.type,
            }))
          }
        }
      }
    }
  }

  walk(tree.children, null)
  return out
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
  out: CreateBlockInput[],
  walk: (nodes: MdNode[] | undefined, parentId: string | null) => void,
): void {
  const ordered = list.ordered === true
  for (const item of list.children ?? []) {
    if (item.type !== 'listItem') continue
    const id = crypto.randomUUID()
    const { text, nested } = splitListItem(item)
    out.push(makeInput(id, notebookId, parentId, BlockType.ListItem, text, listItemProps(item, ordered, doc)))
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
