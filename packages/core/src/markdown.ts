/**
 * Markdown → blocks 手写 parser（现行默认实现）。
 *
 * 并行 mdast 实现见 `./markdown/parseMdast.ts`（尚未接入保存路径）。
 * 契约语料见 `__tests__/markdown-corpus/`。
 */
import { BlockType } from './types'
import type { Block, CreateBlockInput } from './types'
import { stripDocFrontmatter } from './frontmatter'

export interface ParsedBlock {
  type: BlockType
  content: string
  depth: number
  children: ParsedBlock[]
  properties: Record<string, unknown>
}

/** 可容纳子块并保留在解析栈上的容器类型（叶子块不入栈，避免后续兄弟被错误嵌套） */
const CONTAINER_TYPES = new Set<BlockType>([
  BlockType.Document,
  BlockType.Heading,
  BlockType.List,
  BlockType.ListItem,
  BlockType.Quote,
])

export function parseMarkdownToBlocks(markdown: string, notebookId: string): CreateBlockInput[] {
  // 便携导出可能带 frontmatter；解析前剥离，避免 --- 块落入正文
  const { body: markdownBody } = stripDocFrontmatter(markdown)
  const lines = markdownBody.split('\n')
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
  // 空行作为段落/引用的分隔：无空行的连续同类型行合成一块（CommonMark 软换行）
  let blankSeen = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const trimmedStart = line.trimStart()
    if (trimmedStart.startsWith('```')) {
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
        // fenced code 按缩进弹栈，避免挂到 paragraph / 未缩进 list_item 下
        popStackToDepth(stack, root, getLineDepth(line))
        inCodeBlock = true
        codeLang = trimmedStart.slice(3).trim()
      }
      continue
    }

    if (inCodeBlock) {
      codeContent += line + '\n'
      continue
    }

    if (line.trim() === '') {
      blankSeen = true
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
      popStackToDepth(stack, root, parsedDepth)
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

    popStackToDepth(stack, root, parsedDepth)

    const parent = stack[stack.length - 1]
    const last = parent.children[parent.children.length - 1]
    // 软换行：空行才分段；连续 paragraph / quote 合并为一块，行间 \n 保留在 content 里。
    // 一次回车 = 段内换行（阅读态渲染为 <br>），两次回车 = 新段。
    // 一行一块会把段间距撑开，round-trip 还会凭空插入空行，所以仍是合块而非拆块。
    if (
      last &&
      !blankSeen &&
      last.type === parsed.type &&
      (parsed.type === BlockType.Paragraph || parsed.type === BlockType.Quote)
    ) {
      last.content = last.content.length > 0 ? `${last.content}\n${parsed.content}` : parsed.content
      continue
    }
    blankSeen = false

    const expectedDepth = parent.depth + 1

    // 仅列表项允许用 wrapper 填补深度；段落等不再造空 paragraph 壳（否则导出会丢子内容）
    if (parsedDepth > expectedDepth && parsed.type === BlockType.ListItem) {
      const wrapper: ParsedBlock = {
        type: BlockType.List,
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
    // 叶子块不入栈：后续 fenced code / 段落应成为兄弟，而非嵌套子块
    if (CONTAINER_TYPES.has(block.type)) {
      stack.push(block)
    }
  }

  return blocksToCreateInputs(root, notebookId)
}

/** 弹栈至可容纳 depth 的父节点（depth 对应行的缩进层级） */
function popStackToDepth(stack: ParsedBlock[], root: ParsedBlock, depth: number): void {
  while (stack.length > 0) {
    const topDepth = stack[stack.length - 1].depth
    if (depth <= topDepth) {
      stack.pop()
    } else {
      break
    }
  }
  if (stack.length === 0) {
    stack.push(root)
  }
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

  if (/^>/.test(line)) {
    return {
      type: BlockType.Quote,
      content: line.replace(/^>\s?/, ''),
      properties: {},
    }
  }

  const listMatch = line.match(/^(\t| {2,})*([-*+])\s+(.*)/)
  if (listMatch) {
    const t = stripTaskPrefix(listMatch[3])
    return {
      type: BlockType.ListItem,
      content: t.content,
      // marker 保真：记录原始列表标记符（+ / * / -），导出时优先回写，
      // 避免用户的 `+` 列表被归一化成 `-`（存量数据无此字段，导出回退 `-`）
      properties: { ordered: false, marker: listMatch[2], ...t.taskProps },
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
  if (/^>/.test(line)) {
    return 0
  }
  // fenced code 开闭行：按可见缩进算 depth
  if (/^\s*```/.test(line)) {
    const match = line.match(/^(\t| {2,})*/)!
    if (!match[0]) return 0
    const indent = match[0]
    const tabCount = (indent.match(/\t/g) || []).length
    const spaceCount = indent.replace(/\t/g, '').length
    return tabCount + Math.floor(spaceCount / 2)
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

  // compact：引用块内部不插空行（空行会把一个 quote 拆成两段）
  function traverse(children: Block[], depth: number, compact = false) {
    for (let i = 0; i < children.length; i++) {
      const block = children[i]
      // 块间空行：标准 CommonMark 渲染器需要空行分隔段落/标题/代码等块级元素，
      // 不空行会让外部渲染把多段并成一段（用户感知的「空行消失」）；
      // 仅连续列表项之间不空行（会拆散列表），列表与前后块之间照常空行；
      // 多空行由末尾 \n{3,}→\n\n 收敛
      const prev = children[i - 1]
      const inListRun = block.type === BlockType.ListItem && prev?.type === BlockType.ListItem
      if (i > 0 && !compact && !inListRun) {
        lines.push('')
      }
      switch (block.type) {
        case BlockType.Document: {
          const title = (block.content || '').trim()
          if (title && depth === 0) {
            lines.push(`# ${title}`)
            // 标题与正文之间空行（同块间空行规则，防外部渲染并段）
            lines.push('')
          }
          // 若首个子块是与文档标题同文的 H1，跳过该行（仍导出其子内容），
          // 避免 `# title` + `# title` 双行（strip 因有子块未剥、或 API 直写同名 H1）
          let kids = block.children
          if (depth === 0 && title && kids.length > 0) {
            const first = kids[0]
            const level = (first.properties?.headingLevel as number) || 1
            if (
              first.type === BlockType.Heading &&
              level === 1 &&
              (first.content || '').trim() === title
            ) {
              traverse(first.children, depth + 1)
              kids = kids.slice(1)
            }
          }
          traverse(kids, depth)
          break
        }

        case BlockType.Heading: {
          const level = (block.properties.headingLevel as number) || 1
          lines.push(`${'#'.repeat(level)} ${block.content}`)
          traverse(block.children, depth + 1)
          break
        }

        case BlockType.Paragraph:
          if (block.content) {
            lines.push(block.content)
          }
          // 兼容历史错误嵌套：旧解析可能把 code 等塞进 paragraph children
          if (block.children.length > 0) {
            traverse(block.children, depth)
          }
          break

        case BlockType.List: {
          traverse(block.children, depth)
          lines.push('')
          break
        }

        case BlockType.ListItem: {
          const indent = '  '.repeat(Math.max(0, depth - 1))
          // ordered 存为「1.」（CommonMark 渲染时自动重编号）；task 回写 [ ]/[x]；
          // 无序 marker 优先用 parse 记录的原始字符（+ / *），缺省回退 -
          const bullet = block.properties.ordered ? '1.' : (block.properties.marker as string) || '-'
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
          if (block.children.length > 0) {
            traverse(block.children, depth)
          }
          break
        }

        case BlockType.Quote: {
          const prefix = '> '
          const contentLines = block.content.split('\n')
          for (const l of contentLines) {
            lines.push(`${prefix}${l}`)
          }
          traverse(block.children, depth, true)
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
 * 若该 H1 下挂有子块，将子块提升为文档直属后仍剥离 H1（避免导出双行 `# title`）。
 */
export function stripTitleHeading(inputs: CreateBlockInput[], title: string): CreateBlockInput[] {
  const first = inputs[0]
  if (!first || first.type !== BlockType.Heading) return inputs
  const level = (first.properties?.headingLevel as number) || 1
  if (level !== 1) return inputs
  if ((first.content ?? '').trim() !== title.trim()) return inputs
  // 去掉首 H1，并将其直接子块提升到文档根（parent_id = null）
  return inputs
    .filter((inp) => inp.id !== first.id)
    .map((inp) => (inp.parent_id === first.id ? { ...inp, parent_id: null } : inp))
}

/**
 * 从导出的 Markdown 文本中剥离与文档标题重复的首行 `# {title}`。
 * 供 Web 编辑器加载时使用，避免标题框与 textarea 双重显示。
 */
export function stripTitleFromMarkdown(markdown: string, title: string): string {
  const t = title.trim()
  if (!t || !markdown) return markdown
  const lines = markdown.split('\n')
  const first = lines[0]?.trim() ?? ''
  if (first !== `# ${t}`) return markdown
  let start = 1
  if (lines[1] === '') start = 2
  return lines.slice(start).join('\n')
}
