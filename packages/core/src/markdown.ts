import { BlockType } from './types'
import type { Block, CreateBlockInput } from './types'

export interface ParsedBlock {
  type: BlockType
  content: string
  depth: number
  children: ParsedBlock[]
  properties: Record<string, unknown>
}

export function parseMarkdownToBlocks(markdown: string, notebookId: string): CreateBlockInput[] {
  const lines = markdown.split('\n')
  const root: ParsedBlock = {
    type: BlockType.Document,
    content: '',
    depth: -1,
    children: [],
    properties: {},
  }

  const stack: ParsedBlock[] = [root]

  let inCodeBlock = false
  let codeContent = ''
  let codeLang = ''

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        const codeBlock: ParsedBlock = {
          type: BlockType.Code,
          content: codeContent.trimEnd(),
          depth: stack[stack.length - 1].depth + 1,
          children: [],
          properties: codeLang ? { language: codeLang } : {},
        }
        stack[stack.length - 1].children.push(codeBlock)
        inCodeBlock = false
        codeContent = ''
        codeLang = ''
      } else {
        inCodeBlock = true
        codeLang = line.slice(3).trim()
      }
      continue
    }

    if (inCodeBlock) {
      codeContent += line + '\n'
      continue
    }

    if (line.trim() === '') {
      continue
    }

    const parsed = parseLine(line)
    const parsedDepth = getLineDepth(line)

    while (stack.length > 0) {
      const topDepth = stack[stack.length - 1].depth
      if (parsedDepth <= topDepth) {
        stack.pop()
      } else {
        break
      }
    }

    if (stack.length === 0) {
      stack.push(root)
    }

    const parent = stack[stack.length - 1]
    const expectedDepth = parent.depth + 1

    if (parsedDepth > expectedDepth) {
      const wrapper: ParsedBlock = {
        type: parsed.type === BlockType.ListItem ? BlockType.List : parsed.type,
        content: '',
        depth: expectedDepth,
        children: [],
        properties: {},
      }
      parent.children.push(wrapper)
      stack.push(wrapper)
    }

    const block: ParsedBlock = {
      ...parsed,
      depth: stack[stack.length - 1].depth + 1,
      children: [],
    }
    stack[stack.length - 1].children.push(block)
    stack.push(block)
  }

  return blocksToCreateInputs(root, notebookId)
}

function parseLine(line: string): Omit<ParsedBlock, 'depth' | 'children'> {
  if (/^#{1,6}\s/.test(line)) {
    const match = line.match(/^(#{1,6})\s+(.*)/)!
    const level = match[1].length
    return {
      type: BlockType.Heading,
      content: match[2],
      properties: { headingLevel: level },
    }
  }

  if (/^>\s/.test(line)) {
    return {
      type: BlockType.Quote,
      content: line.replace(/^>\s?/, ''),
      properties: {},
    }
  }

  const listMatch = line.match(/^(\t| {2,})*[-*+]\s+(.*)/)
  if (listMatch) {
    return {
      type: BlockType.ListItem,
      content: listMatch[2],
      properties: {},
    }
  }

  const orderedMatch = line.match(/^(\t| {2,})*\d+\.\s+(.*)/)
  if (orderedMatch) {
    return {
      type: BlockType.ListItem,
      content: orderedMatch[2],
      properties: {},
    }
  }

  return {
    type: BlockType.Paragraph,
    content: line.trim(),
    properties: {},
  }
}

function getLineDepth(line: string): number {
  if (/^#{1,6}\s/.test(line)) {
    return 0
  }
  if (/^>\s/.test(line)) {
    return 0
  }
  const match = line.match(/^(\t| {2,})*/)
  if (!match || !match[0]) return 0
  const indent = match[0]
  const tabCount = (indent.match(/\t/g) || []).length
  const spaceCount = indent.replace(/\t/g, '').length
  return tabCount + Math.floor(spaceCount / 2)
}

function blocksToCreateInputs(root: ParsedBlock, notebookId: string): CreateBlockInput[] {
  const inputs: CreateBlockInput[] = []
  let docTitle = ''

  const idMap = new Map<string, string>()

  function assignIds(parsed: ParsedBlock) {
    const id = crypto.randomUUID()
    idMap.set(
      JSON.stringify({ content: parsed.content, type: parsed.type }),
      id,
    )
    for (const child of parsed.children) {
      assignIds(child)
    }
  }

  const tempRoot: ParsedBlock = { ...root }
  for (const child of tempRoot.children) {
    assignIds(child)
  }

  function buildInputs(parsed: ParsedBlock, parentId: string | null): void {
    if (parsed.type === BlockType.Document) {
      for (const child of parsed.children) {
        buildInputs(child, parentId)
      }
      return
    }

    if (parsed.type === BlockType.List) {
      for (const child of parsed.children) {
        buildInputs(child, parentId)
      }
      return
    }

    const id = crypto.randomUUID()
    if (!docTitle && parsed.type === BlockType.Heading) {
      docTitle = parsed.content
    }

    inputs.push({
      notebook_id: notebookId,
      parent_id: parentId,
      type: parsed.type,
      content: parsed.content,
      properties: parsed.properties,
      sort: 0,
    })

    for (const child of parsed.children) {
      buildInputs(child, id)
    }
  }

  buildInputs(tempRoot, null)
  return inputs
}

export function blocksToMarkdown(blocks: Block[]): string {
  const lines: string[] = []

  function traverse(children: Block[], depth: number) {
    for (const block of children) {
      switch (block.type) {
        case BlockType.Document:
          if (block.content && depth === 0) {
            lines.push(`# ${block.content}`)
          }
          traverse(block.children, depth)
          break

        case BlockType.Heading: {
          const level = (block.properties.headingLevel as number) || 1
          lines.push(`${'#'.repeat(level)} ${block.content}`)
          traverse(block.children, depth + 1)
          break
        }

        case BlockType.Paragraph:
          lines.push(block.content)
          break

        case BlockType.List: {
          traverse(block.children, depth)
          lines.push('')
          break
        }

        case BlockType.ListItem: {
          const indent = '  '.repeat(Math.max(0, depth - 1))
          lines.push(`${indent}- ${block.content}`)
          traverse(block.children, depth + 1)
          break
        }

        case BlockType.Code: {
          const lang = (block.properties.language as string) || ''
          lines.push('```' + lang)
          lines.push(block.content)
          lines.push('```')
          break
        }

        case BlockType.Quote: {
          const prefix = '> '
          const contentLines = block.content.split('\n')
          for (const l of contentLines) {
            lines.push(`${prefix}${l}`)
          }
          traverse(block.children, depth)
          break
        }
      }
    }
  }

  traverse(blocks, 0)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n'
}
