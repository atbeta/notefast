import type { BlockRow, Block, CreateBlockInput, UpdateBlockInput, MoveBlockInput, DocSummary, HeadingNode } from './types'
import { BlockType } from './types'
import { readTags } from './tags'
import { readDocStatus } from './docStatus'

const BLOCK_TYPE_VALUES = Object.values(BlockType)

export function rowToBlock(row: BlockRow): Block {
  let properties: Record<string, unknown> = {}
  try {
    properties = JSON.parse(row.properties)
  } catch {
    properties = {}
  }

  return {
    id: row.id,
    notebook_id: row.notebook_id,
    parent_id: row.parent_id,
    root_id: row.root_id,
    type: row.type as BlockType,
    content: row.content,
    properties,
    tags: readTags(row),
    status: readDocStatus(row),
    ai_exclude: row.ai_exclude === 1,
    sort: row.sort,
    level: row.level,
    created_at: row.created_at,
    updated_at: row.updated_at,
    children: [],
  }
}

export function isBlockType(value: string): value is BlockType {
  return BLOCK_TYPE_VALUES.includes(value as BlockType)
}

export function validateBlockType(value: string): BlockType {
  if (!isBlockType(value)) {
    throw new Error(`无效的块类型: ${value}`)
  }
  return value
}

function buildTree(rows: BlockRow[]): Block[] {
  const blockMap = new Map<string, Block>()
  const roots: Block[] = []

  for (const row of rows) {
    blockMap.set(row.id, rowToBlock(row))
  }

  for (const block of blockMap.values()) {
    if (block.parent_id && blockMap.has(block.parent_id)) {
      blockMap.get(block.parent_id)!.children.push(block)
    } else {
      roots.push(block)
    }
  }

  const sortBlocks = (blocks: Block[]) => {
    blocks.sort((a, b) => a.sort - b.sort)
    for (const block of blocks) {
      sortBlocks(block.children)
    }
  }

  sortBlocks(roots)
  return roots
}

export function buildBlockTree(rows: BlockRow[]): Block[] {
  return buildTree(rows)
}

export function buildHeadingTree(blocks: Block[]): HeadingNode[] {
  const headings: HeadingNode[] = []

  function collect(children: Block[], _depth: number) {
    for (const block of children) {
      if (block.type === BlockType.Heading) {
        const hLevel = (block.properties.headingLevel as number) || 1
        const node: HeadingNode = {
          id: block.id,
          content: block.content,
          level: hLevel,
          children: [],
        }
        headings.push(node)
        collect(block.children, hLevel)
      } else {
        collect(block.children, 0)
      }
    }
  }

  collect(blocks, 0)
  return nestHeadingTree(headings)
}

function nestHeadingTree(flat: HeadingNode[]): HeadingNode[] {
  const roots: HeadingNode[] = []
  const stack: HeadingNode[] = []

  for (const node of flat) {
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop()
    }
    if (stack.length === 0) {
      roots.push(node)
    } else {
      stack[stack.length - 1].children.push(node)
    }
    stack.push(node)
  }

  return roots
}

export function createDocInput(notebookId: string, title: string): CreateBlockInput {
  return {
    notebook_id: notebookId,
    parent_id: null,
    type: BlockType.Document,
    content: title,
    sort: 0,
  }
}

export function createBlockInput(
  notebookId: string,
  type: BlockType,
  parentId: string,
  opts?: { content?: string; properties?: Record<string, unknown>; sort?: number; level?: number },
): CreateBlockInput {
  return {
    notebook_id: notebookId,
    parent_id: parentId,
    type,
    content: opts?.content ?? '',
    properties: opts?.properties ?? {},
    sort: opts?.sort ?? 0,
  }
}

const CONTAINER_TYPES: string[] = [BlockType.Document, BlockType.Heading, BlockType.List, BlockType.ListItem, BlockType.Quote]

function isContainerType(type: BlockType): boolean {
  return CONTAINER_TYPES.includes(type)
}

export function inputsToBlockTree(inputs: CreateBlockInput[]): Block[] {
  const rows: BlockRow[] = inputs.map((inp) => ({
    id: inp.id ?? crypto.randomUUID(),
    notebook_id: inp.notebook_id,
    parent_id: inp.parent_id ?? null,
    root_id: '',
    type: inp.type,
    content: inp.content ?? '',
    properties: JSON.stringify(inp.properties ?? {}),
    tags: '[]',
    status: 'note',
    ai_exclude: 0,
    sort: inp.sort ?? 0,
    level: 0,
    created_at: '',
    updated_at: '',
  }))
  return buildTree(rows)
}

export { buildTree, isContainerType }
export type { BlockRow, Block, CreateBlockInput, UpdateBlockInput, MoveBlockInput, DocSummary, HeadingNode }
