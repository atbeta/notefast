import { describe, expect, test } from 'bun:test'
import { BlockType, type Block } from '@notefast/core'
import { resolveRelatedBlockId, scanMarkdownBlocks } from '../relatedAnchor'

function block(partial: Partial<Block> & { id: string; type: Block['type']; content: string }): Block {
  return {
    notebook_id: 'nb',
    parent_id: null,
    root_id: 'doc',
    properties: {},
    tags: [],
    status: 'note',
    ai_exclude: false,
    sort: 0,
    level: 0,
    created_at: '',
    updated_at: '',
    children: [],
    ...partial,
  }
}

describe('scanMarkdownBlocks', () => {
  test('段落与标题按空行切开', () => {
    const md = '第一段\n\n## 节\n\n第二段'
    const spans = scanMarkdownBlocks(md)
    expect(spans.map((s) => s.content)).toEqual(['第一段', '节', '第二段'])
    expect(resolveRelatedBlockId(
      block({
        id: 'doc',
        type: BlockType.Document,
        content: '标题',
        children: [
          block({ id: 'p1', type: BlockType.Paragraph, content: '第一段' }),
          block({ id: 'h', type: BlockType.Heading, content: '节' }),
          block({ id: 'p2', type: BlockType.Paragraph, content: '第二段' }),
        ],
      }),
      md,
      md.indexOf('第二'),
    )).toBe('p2')
  })

  test('空文或对不上时返回 null', () => {
    const doc = block({ id: 'doc', type: BlockType.Document, content: '标题' })
    expect(resolveRelatedBlockId(doc, '', 0)).toBeNull()
  })

  test('较长围栏内的 ``` 不提前切块', () => {
    const md = ['````md', '```js', 'code', '```', '````'].join('\n')
    const spans = scanMarkdownBlocks(md)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.content).toContain('```js')
    expect(spans[0]?.content).toContain('code')
  })

  test('~~~ 围栏与反引号同等切成一块', () => {
    const md = ['~~~', 'code', '~~~', '', '后段'].join('\n')
    expect(scanMarkdownBlocks(md).map((s) => s.content)).toEqual(['code', '后段'])
  })

  test('闭合独占行 $$ 切成一块', () => {
    const md = ['前段', '', '$$', 'E = mc^2', '$$', '', '后段'].join('\n')
    expect(scanMarkdownBlocks(md).map((s) => s.content)).toEqual(['前段', 'E = mc^2', '后段'])
  })
})
