import { describe, test, expect } from 'bun:test'
import { parseMarkdownToBlocks, blocksToMarkdown, stripTitleHeading } from '../markdown'
import { BlockType } from '../types'

describe('parseMarkdownToBlocks', () => {
  test('解析标题和段落', () => {
    const markdown = `# 标题一

一些段落文字。

## 标题二

更多段落。`
    const inputs = parseMarkdownToBlocks(markdown, 'nb1')

    const headings = inputs.filter((i) => i.type === BlockType.Heading)
    const paragraphs = inputs.filter((i) => i.type === BlockType.Paragraph)

    expect(headings.length).toBe(2)
    expect(headings[0].content).toBe('标题一')
    expect(headings[1].content).toBe('标题二')
    expect(paragraphs.length).toBe(2)
  })

  test('解析代码块', () => {
    const markdown = `# 代码示例

\`\`\`typescript
const x = 1
console.log(x)
\`\`\``
    const inputs = parseMarkdownToBlocks(markdown, 'nb1')

    const codeBlocks = inputs.filter((i) => i.type === BlockType.Code)
    expect(codeBlocks.length).toBe(1)
    expect(codeBlocks[0].content).toBe('const x = 1\nconsole.log(x)')
    expect(codeBlocks[0].properties?.language).toBe('typescript')
  })

  test('解析列表', () => {
    const markdown = `- 项目一
- 项目二
- 项目三`
    const inputs = parseMarkdownToBlocks(markdown, 'nb1')

    const listItems = inputs.filter((i) => i.type === BlockType.ListItem)
    expect(listItems.length).toBe(3)
  })

  test('解析引用块', () => {
    const markdown = `> 这是一段引用文字`
    const inputs = parseMarkdownToBlocks(markdown, 'nb1')

    const quotes = inputs.filter((i) => i.type === BlockType.Quote)
    expect(quotes.length).toBe(1)
    expect(quotes[0].content).toBe('这是一段引用文字')
  })

  test('空内容返回空数组', () => {
    const inputs = parseMarkdownToBlocks('', 'nb1')
    expect(inputs.length).toBe(0)
  })

  test('解析管道表格', () => {
    const markdown = `| 类型 | 说明 |
| --- | --- |
| document | 根节点 |
| heading | 标题 |`
    const inputs = parseMarkdownToBlocks(markdown, 'nb1')

    const tables = inputs.filter((i) => i.type === BlockType.Table)
    expect(tables.length).toBe(1)
    expect(tables[0].content).toContain('| 类型 | 说明 |')
    expect(tables[0].content).toContain('| heading | 标题 |')
    expect(inputs.filter((i) => i.type === BlockType.Paragraph).length).toBe(0)
  })

  test('表格后接普通行正确分块', () => {
    const markdown = `| A | B |
| --- | --- |
| 1 | 2 |

普通段落`
    const inputs = parseMarkdownToBlocks(markdown, 'nb1')
    expect(inputs.filter((i) => i.type === BlockType.Table).length).toBe(1)
    const paragraphs = inputs.filter((i) => i.type === BlockType.Paragraph)
    expect(paragraphs.length).toBe(1)
    expect(paragraphs[0].content).toBe('普通段落')
  })

  test('含 | 但无分隔行不识别为表格', () => {
    const markdown = `这是一段 | 含有竖线 | 的文字`
    const inputs = parseMarkdownToBlocks(markdown, 'nb1')
    expect(inputs.filter((i) => i.type === BlockType.Table).length).toBe(0)
  })
})

describe('stripTitleHeading', () => {
  test('剥离与标题一致的首个一级标题', () => {
    const inputs = parseMarkdownToBlocks('# 测试\n\n正文内容', 'nb1')
    const stripped = stripTitleHeading(inputs, '测试')
    expect(stripped.filter((i) => i.type === BlockType.Heading).length).toBe(0)
    expect(stripped.filter((i) => i.type === BlockType.Paragraph).length).toBe(1)
  })

  test('标题不一致时不剥离', () => {
    const inputs = parseMarkdownToBlocks('# 别的标题\n\n正文', 'nb1')
    const stripped = stripTitleHeading(inputs, '测试')
    expect(stripped.length).toBe(inputs.length)
  })

  test('一级标题有子块时不剥离', () => {
    const inputs = parseMarkdownToBlocks('# 测试\n\n  缩进内容', 'nb1')
    const stripped = stripTitleHeading(inputs, '测试')
    expect(stripped.length).toBe(inputs.length)
  })
})

describe('blocksToMarkdown', () => {
  function makeBlock(id: string, type: string, content: string, parentId: string | null, children: any[] = [], props: Record<string, unknown> = {}): any {
    return {
      id, notebook_id: 'nb1', parent_id: parentId, root_id: 'doc',
      type, content, properties: props, sort: 0, level: parentId ? 1 : 0,
      created_at: '', updated_at: '', children,
    }
  }

  test('导出标题和段落', () => {
    const blocks = [
      makeBlock('doc', 'document', '测试文档', null, [
        makeBlock('h1', 'heading', '标题', 'doc', [
          makeBlock('p1', 'paragraph', '段落内容', 'h1'),
        ], { headingLevel: 2 }),
      ]),
    ]

    const md = blocksToMarkdown(blocks)
    expect(md).toContain('# 测试文档')
    expect(md).toContain('## 标题')
    expect(md).toContain('段落内容')
  })

  test('导出代码块', () => {
    const blocks = [
      makeBlock('doc', 'document', '代码文档', null, [
        makeBlock('c1', 'code', 'console.log("hello")', 'doc', [], { language: 'javascript' }),
      ]),
    ]

    const md = blocksToMarkdown(blocks)
    expect(md).toContain('```javascript')
    expect(md).toContain('console.log("hello")')
    expect(md).toContain('```')
  })

  test('导出列表', () => {
    const blocks = [
      makeBlock('doc', 'document', '列表文档', null, [
        makeBlock('l1', 'list_item', '项目A', 'doc'),
        makeBlock('l2', 'list_item', '项目B', 'doc'),
      ]),
    ]

    const md = blocksToMarkdown(blocks)
    expect(md).toContain('- 项目A')
    expect(md).toContain('- 项目B')
  })

  test('导出表格并保证 roundtrip', () => {
    const raw = '| 类型 | 说明 |\n| --- | --- |\n| document | 根节点 |'
    const blocks = [
      makeBlock('doc', 'document', '表格文档', null, [
        makeBlock('t1', 'table', raw, 'doc'),
      ]),
    ]

    const md = blocksToMarkdown(blocks)
    expect(md).toContain('| 类型 | 说明 |')
    expect(md).toContain('| --- | --- |')

    // roundtrip：再次解析仍是一个表格块
    const reparsed = parseMarkdownToBlocks(md, 'nb1')
    expect(reparsed.filter((i) => i.type === BlockType.Table).length).toBe(1)
  })
})
