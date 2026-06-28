import { describe, test, expect } from 'bun:test'
import { buildBlockTree, buildHeadingTree, rowToBlock, isContainerType } from '../model'
import { BlockType } from '../types'
import type { BlockRow } from '../types'

describe('rowToBlock', () => {
  test('转换行数据为 Block 对象', () => {
    const row: BlockRow = {
      id: 'b1',
      notebook_id: 'nb1',
      parent_id: null,
      root_id: 'b1',
      type: 'document',
      content: '我的文档',
      properties: '{}',
      sort: 0,
      level: 0,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    }

    const block = rowToBlock(row)
    expect(block.id).toBe('b1')
    expect(block.type).toBe('document')
    expect(block.content).toBe('我的文档')
    expect(block.children).toEqual([])
  })

  test('转换带 properties 的行数据', () => {
    const row: BlockRow = {
      id: 'b2',
      notebook_id: 'nb1',
      parent_id: null,
      root_id: 'b2',
      type: 'heading',
      content: '标题',
      properties: '{"headingLevel":2,"tag":"重要"}',
      sort: 0,
      level: 0,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    }

    const block = rowToBlock(row)
    expect(block.properties).toEqual({ headingLevel: 2, tag: '重要' })
  })

  test('properties 解析失败时返回空对象', () => {
    const row: BlockRow = {
      id: 'b3',
      notebook_id: 'nb1',
      parent_id: null,
      root_id: 'b3',
      type: 'paragraph',
      content: 'text',
      properties: 'invalid json',
      sort: 0,
      level: 0,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    }

    const block = rowToBlock(row)
    expect(block.properties).toEqual({})
  })
})

describe('buildBlockTree', () => {
  function makeRow(id: string, parentId: string | null, obj: Partial<BlockRow> = {}): BlockRow {
    return {
      id, notebook_id: 'nb1', parent_id: parentId, root_id: 'doc', type: 'paragraph', content: '',
      properties: '{}', sort: 0, level: parentId ? 1 : 0, created_at: '', updated_at: '', ...obj,
    }
  }

  test('构建单层 block 树', () => {
    const rows: BlockRow[] = [
      makeRow('doc', null, { type: 'document', content: '文档' }),
      makeRow('h1', 'doc', { type: 'heading', content: '标题1' }),
      makeRow('p1', 'doc', { type: 'paragraph', content: '段落', sort: 1 }),
    ]

    const tree = buildBlockTree(rows)
    expect(tree.length).toBe(1)
    expect(tree[0].children.length).toBe(2)
  })

  test('构建嵌套 block 树', () => {
    const rows: BlockRow[] = [
      makeRow('doc', null, { type: 'document', content: '文档' }),
      makeRow('h1', 'doc', { type: 'heading', content: '标题1' }),
      makeRow('h2', 'h1', { type: 'heading', content: '子标题' }),
    ]

    const tree = buildBlockTree(rows)
    expect(tree.length).toBe(1)
    expect(tree[0].children[0].children.length).toBe(1)
    expect(tree[0].children[0].children[0].content).toBe('子标题')
  })

  test('空数组返回空树', () => {
    const tree = buildBlockTree([])
    expect(tree.length).toBe(0)
  })
})

describe('buildHeadingTree', () => {
  function makeBlock(id: string, content: string, headingLevel: number, children: any[] = []): any {
    return {
      id, notebook_id: '', parent_id: null, root_id: '', type: 'heading',
      content, properties: { headingLevel }, sort: 0, level: 0,
      created_at: '', updated_at: '', children,
    }
  }

  test('从 block 树提取 heading 层级', () => {
    const blocks = [
      makeBlock('h1', '一级', 1, [
        makeBlock('h2', '二级', 2, [
          makeBlock('h3', '三级', 3),
        ]),
      ]),
    ]

    const tree = buildHeadingTree(blocks)
    expect(tree.length).toBe(1)
    expect(tree[0].content).toBe('一级')
    expect(tree[0].children.length).toBe(1)
    expect(tree[0].children[0].content).toBe('二级')
    expect(tree[0].children[0].children[0].content).toBe('三级')
  })
})

describe('isContainerType', () => {
  test('容器类型返回 true', () => {
    expect(isContainerType(BlockType.Document)).toBe(true)
    expect(isContainerType(BlockType.Heading)).toBe(true)
    expect(isContainerType(BlockType.List)).toBe(true)
    expect(isContainerType(BlockType.ListItem)).toBe(true)
    expect(isContainerType(BlockType.Quote)).toBe(true)
  })

  test('非容器类型返回 false', () => {
    expect(isContainerType(BlockType.Paragraph)).toBe(false)
    expect(isContainerType(BlockType.Code)).toBe(false)
  })
})
