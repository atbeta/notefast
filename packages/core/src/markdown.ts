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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

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

    // 管道表格：当前行含 | 且下一行是分隔行（--- / :---: 等）
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      isTableDelimiter(lines[i + 1])
    ) {
      const tableLines = [line, lines[i + 1]]
      let j = i + 2
      while (j < lines.length && isTableRow(lines[j])) {
        tableLines.push(lines[j])
        j++
      }
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
      const tableBlock: ParsedBlock = {
        type: BlockType.Table,
        content: tableLines.join('\n'),
        depth: stack[stack.length - 1].depth + 1,
        children: [],
        properties: {},
      }
      // 叶子块，不入栈 —— 后续行作为同级兄弟处理
      stack[stack.length - 1].children.push(tableBlock)
      i = j - 1
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

/** 表格行：行内含 | 且非空白 */
function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.length > 0 && t.includes('|')
}

/** 表格分隔行：| --- | :--- | ---: | :---: | 形态 */
function isTableDelimiter(line: string): boolean {
  const t = line.trim()
  if (!t.includes('-')) return false
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|')
  if (cells.length === 0) return false
  return cells.every((c) => /^:?-+:?$/.test(c.trim()))
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
    const t = stripTaskPrefix(listMatch[2])
    return {
      type: BlockType.ListItem,
      content: t.content,
      properties: { ordered: false, ...t.taskProps },
    }
  }

  const orderedMatch = line.match(/^(\t| {2,})*\d+\.\s+(.*)/)
  if (orderedMatch) {
    const t = stripTaskPrefix(orderedMatch[2])
    return {
      type: BlockType.ListItem,
      content: t.content,
      properties: { ordered: true, ...t.taskProps },
    }
  }

  return {
    type: BlockType.Paragraph,
    content: line.trim(),
    properties: {},
  }
}

/** 任务列表前缀：`- [ ] xxx` / `- [x] xxx`（无序/有序通用） */
function stripTaskPrefix(raw: string): { content: string; taskProps: Record<string, unknown> } {
  const m = raw.match(/^\[( |x|X)\]\s+(.*)/)
  if (!m) return { content: raw, taskProps: {} }
  return { content: m[2], taskProps: { task: true, checked: m[1].toLowerCase() === 'x' } }
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
      id,
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

  buildInputs(root, null)
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
          // ordered 存为「1.」（CommonMark 渲染时自动重编号）；task 回写 [ ]/[x]
          const bullet = block.properties.ordered ? '1.' : '-'
          const task = block.properties.task
            ? `[${block.properties.checked ? 'x' : ' '}] `
            : ''
          lines.push(`${indent}${bullet} ${task}${block.content}`)
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

        case BlockType.Table: {
          // 表格内容原样存 raw 管道文本，序列化直接回写
          for (const l of block.content.split('\n')) {
            lines.push(l)
          }
          break
        }
      }
    }
  }

  traverse(blocks, 0)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n'
}

/**
 * 剥离与文档标题重复的首个一级标题。
 *
 * 背景：导出的 Markdown 首行是 `# {文档标题}`（见 blocksToMarkdown），
 * 若不加处理地回解析，该标题会作为普通 heading block 入库，
 * 导致每保存一次正文中就多一个与标题重复的 heading（大纲重复、正文重复）。
 *
 * 仅当首个 block 是一级标题、内容与标题一致、且无子块时剥离，
 * 避免误删用户有意书写的内容。
 */
export function stripTitleHeading(inputs: CreateBlockInput[], title: string): CreateBlockInput[] {
  const first = inputs[0]
  if (!first || first.type !== BlockType.Heading) return inputs
  const level = (first.properties?.headingLevel as number) || 1
  if (level !== 1) return inputs
  if ((first.content ?? '').trim() !== title.trim()) return inputs
  const hasChildren = inputs.some((inp) => inp.parent_id === first.id)
  if (hasChildren) return inputs
  return inputs.slice(1)
}
