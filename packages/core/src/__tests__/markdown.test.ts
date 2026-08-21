import { describe, test, expect } from 'bun:test'
import { parseMarkdownToBlocks, blocksToMarkdown, stripTitleHeading, stripTitleFromMarkdown } from '../markdown'
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

  test('段落后的多个 fenced code 为兄弟块（Bug 21）', () => {
    const inputs = parseMarkdownToBlocks('intro\n\n```\nA\n```\n\n```\nB\n```\n', 'nb1')
    const codes = inputs.filter((i) => i.type === BlockType.Code)
    expect(codes.length).toBe(2)
    expect(codes[0].content).toBe('A')
    expect(codes[1].content).toBe('B')
    expect(codes[0].parent_id == null).toBe(true)
    expect(codes[1].parent_id == null).toBe(true)
  })

  test('列表后未缩进的 fenced code 不嵌套进 list_item（Bug 29）', () => {
    const inputs = parseMarkdownToBlocks('- item 3\n```python\ncode\n```\n', 'nb1')
    const item = inputs.find((i) => i.type === BlockType.ListItem)
    const code = inputs.find((i) => i.type === BlockType.Code)
    expect(item?.content).toBe('item 3')
    expect(code?.content).toBe('code')
    expect(code?.parent_id == null).toBe(true)
  })

  test('缩进段落导出不丢内容（Bug 20）', () => {
    const md = '# title\n\n    indented\n    more\n'
    const inputs = parseMarkdownToBlocks(md, 'nb1')
    const byId = new Map<string, any>()
    const roots: any[] = []
    for (const i of inputs) {
      byId.set(i.id!, {
        id: i.id!,
        notebook_id: 'nb1',
        parent_id: i.parent_id ?? null,
        root_id: 'doc',
        type: i.type,
        content: i.content ?? '',
        properties: i.properties ?? {},
        sort: 0,
        level: 1,
        created_at: '',
        updated_at: '',
        children: [] as any[],
      })
    }
    for (const i of inputs) {
      const node = byId.get(i.id!)!
      if (i.parent_id && byId.has(i.parent_id)) byId.get(i.parent_id)!.children.push(node)
      else roots.push(node)
    }
    const out = blocksToMarkdown(roots)
    expect(out).toContain('indented')
    expect(out).toContain('more')
  })

  test('历史错误嵌套：paragraph 下的 code 仍能导出', () => {
    const blocks = [
      {
        id: 'doc', notebook_id: 'nb1', parent_id: null, root_id: 'doc',
        type: 'document', content: 't', properties: {}, sort: 0, level: 0,
        created_at: '', updated_at: '',
        children: [
          {
            id: 'p', notebook_id: 'nb1', parent_id: 'doc', root_id: 'doc',
            type: 'paragraph', content: 'intro', properties: {}, sort: 0, level: 1,
            created_at: '', updated_at: '',
            children: [
              {
                id: 'c', notebook_id: 'nb1', parent_id: 'p', root_id: 'doc',
                type: 'code', content: 'A', properties: {}, sort: 0, level: 2,
                created_at: '', updated_at: '', children: [],
              },
            ],
          },
        ],
      },
    ]
    const out = blocksToMarkdown(blocks as any)
    expect(out).toContain('intro')
    expect(out).toContain('```')
    expect(out).toContain('A')
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

  test('一级标题有子块时提升子块并剥离', () => {
    const inputs = parseMarkdownToBlocks('# 测试\n\n  缩进内容', 'nb1')
    const stripped = stripTitleHeading(inputs, '测试')
    expect(stripped.filter((i) => i.type === BlockType.Heading).length).toBe(0)
    const paras = stripped.filter((i) => i.type === BlockType.Paragraph)
    expect(paras.length).toBe(1)
    expect(paras[0].content).toBe('缩进内容')
    expect(paras[0].parent_id == null).toBe(true)
  })
})

describe('stripTitleFromMarkdown', () => {
  test('剥离导出首行重复标题', () => {
    expect(stripTitleFromMarkdown('# 我的文档\n\n正文\n', '我的文档')).toBe('正文\n')
  })

  test('标题不一致时不剥离', () => {
    expect(stripTitleFromMarkdown('# 别的\n\n正文\n', '我的文档')).toBe('# 别的\n\n正文\n')
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

  test('文档标题与同名首 H1 不重复输出', () => {
    const blocks = [
      makeBlock('doc', 'document', '标题', null, [
        makeBlock('h1', 'heading', '标题', 'doc', [
          makeBlock('p1', 'paragraph', '正文', 'h1'),
        ], { headingLevel: 1 }),
      ]),
    ]
    const md = blocksToMarkdown(blocks)
    expect(md).toBe('# 标题\n\n正文\n')
  })

  test('文档标题与不同文首 H1 都保留', () => {
    const blocks = [
      makeBlock('doc', 'document', '文档名', null, [
        makeBlock('h1', 'heading', '章节', 'doc', [], { headingLevel: 1 }),
      ]),
    ]
    const md = blocksToMarkdown(blocks)
    expect(md).toBe('# 文档名\n\n# 章节\n')
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

describe('列表增强（ordered / task）', () => {
  test('有序列表带 ordered=true，无序带 ordered=false', () => {
    const inputs = parseMarkdownToBlocks('- a\n- b\n\n1. first\n2. second\n', 'nb')
    const items = inputs.filter((i) => i.type === BlockType.ListItem)
    const unordered = items.filter((i) => i.properties?.ordered === false)
    const ordered = items.filter((i) => i.properties?.ordered === true)
    expect(unordered.length).toBe(2)
    expect(ordered.length).toBe(2)
    expect(ordered[0].content).toBe('first')
    expect(ordered[1].content).toBe('second')
  })

  test('任务列表解析 task/checked 并剥离前缀', () => {
    const inputs = parseMarkdownToBlocks('- [ ] todo\n- [x] done\n- [X] done2\n- plain\n', 'nb')
    const items = inputs.filter((i) => i.type === BlockType.ListItem)
    expect(items[0]?.content).toBe('todo')
    expect(items[0]?.properties?.task).toBe(true)
    expect(items[0]?.properties?.checked).toBe(false)
    expect(items[1]?.properties?.checked).toBe(true)
    expect(items[2]?.properties?.checked).toBe(true)
    expect(items[3]?.properties?.task).toBeUndefined()
    expect(items[3]?.content).toBe('plain')
  })

  test('导出回写：ordered → 1.，task → [ ]/[x]', () => {
    const md = '- [ ] todo\n- [x] done\n\n1. first\n2. second\n'
    const inputs = parseMarkdownToBlocks(md, 'nb')
    const blocks = inputs.map((i) => ({
      id: i.id ?? 'x',
      notebook_id: 'nb',
      parent_id: null,
      root_id: 'x',
      type: i.type,
      content: i.content ?? '',
      properties: i.properties ?? {},
      tags: [] as string[],
      status: 'note' as const,
      ai_exclude: false,
      sort: 0,
      level: 1,
      created_at: '',
      updated_at: '',
      children: [],
    }))
    const out = blocksToMarkdown(blocks)
    expect(out).toContain('- [ ] todo')
    expect(out).toContain('- [x] done')
    expect(out).toContain('1. first')
    expect(out).toContain('1. second')
    // 导出的 markdown 再解析，标记不丢失（roundtrip 闭环）
    const re = parseMarkdownToBlocks(out, 'nb')
    const reItems = re.filter((i) => i.type === BlockType.ListItem)
    expect(reItems.filter((i) => i.properties?.task).length).toBe(2)
    expect(reItems.filter((i) => i.properties?.ordered === true).length).toBe(2)
  })
})

describe('格式保真（marker / 块间空行）', () => {
  // makeBlock 定义在上方 blocksToMarkdown describe 内（作用域不可达），此处本地复刻
  function makeBlock(id: string, type: string, content: string, parentId: string | null, children: any[] = [], props: Record<string, unknown> = {}): any {
    return {
      id, notebook_id: 'nb1', parent_id: parentId, root_id: 'doc',
      type, content, properties: props, sort: 0, level: parentId ? 1 : 0,
      created_at: '', updated_at: '', children,
    }
  }

  test('无序列表原始 marker 保真：+ 和 * 不再被归一化成 -', () => {
    const inputs = parseMarkdownToBlocks('+ 苹果\n* 香蕉\n- 橘子', 'nb')
    expect(inputs[0]!.properties?.marker).toBe('+')
    expect(inputs[1]!.properties?.marker).toBe('*')
    expect(inputs[2]!.properties?.marker).toBe('-')

    const blocks = inputs.map((inp, i) =>
      makeBlock(`l${i}`, 'list_item', inp.content ?? '', 'doc', [], inp.properties),
    )
    const md = blocksToMarkdown(blocks)
    expect(md).toContain('+ 苹果')
    expect(md).toContain('* 香蕉')
    expect(md).toContain('- 橘子')
  })

  test('存量数据无 marker 字段时导出回退 -', () => {
    const blocks = [makeBlock('l1', 'list_item', '旧数据', 'doc', [], { ordered: false })]
    expect(blocksToMarkdown(blocks)).toContain('- 旧数据')
  })

  test('段落/标题/代码块之间导出空行（外部渲染不并段），列表项之间不空行', () => {
    const blocks = [
      makeBlock('h1', 'heading', '章节', null, [], { headingLevel: 2 }),
      makeBlock('p1', 'paragraph', '第一段', null),
      makeBlock('p2', 'paragraph', '第二段', null),
      makeBlock('l1', 'list_item', '项目A', null),
      makeBlock('l2', 'list_item', '项目B', null),
    ]
    const md = blocksToMarkdown(blocks)
    expect(md).toBe('## 章节\n\n第一段\n\n第二段\n\n- 项目A\n- 项目B\n')
  })

  test('块间空行不破坏 round-trip（parse 跳过空行）', () => {
    const original = '## 章节\n\n第一段\n\n第二段\n\n+ 项目A\n+ 项目B\n'
    const inputs = parseMarkdownToBlocks(original, 'nb')
    const blocks = inputs.map((inp, i) =>
      makeBlock(`b${i}`, inp.type, inp.content ?? '', null, [], inp.properties),
    )
    // 重建导出（list_item 平铺，无 List 容器嵌套）
    expect(blocksToMarkdown(blocks)).toBe(original)
  })
})

describe('块级语义：段落一行一块（Quote 保留合段）', () => {
  test('连续非空行段落保留为多个块，不按 CommonMark 软换行合并', () => {
    const inputs = parseMarkdownToBlocks('第一行硬换行\n第二行继续。\n\n下一段。', 'nb')
    const paras = inputs.filter((i) => i.type === BlockType.Paragraph)
    expect(paras.length).toBe(3)
    expect(paras[0]!.content).toBe('第一行硬换行')
    expect(paras[1]!.content).toBe('第二行继续。')
    expect(paras[2]!.content).toBe('下一段。')
  })

  test('英文两行也保留为两块（不补空格合并）', () => {
    const inputs = parseMarkdownToBlocks('This is a\nlong line.\n\nNext.', 'nb')
    const paras = inputs.filter((i) => i.type === BlockType.Paragraph)
    expect(paras.length).toBe(3)
    expect(paras[0]!.content).toBe('This is a')
    expect(paras[1]!.content).toBe('long line.')
  })

  test('连续引用行合成一块（多行引用块）', () => {
    const inputs = parseMarkdownToBlocks('> 第一行\n> 第二行\n\n> 另一块', 'nb')
    const quotes = inputs.filter((i) => i.type === BlockType.Quote)
    expect(quotes.length).toBe(2)
    expect(quotes[0]!.content).toBe('第一行\n第二行')
    expect(quotes[1]!.content).toBe('另一块')
  })

  test('标题后的两行段落保留两块', () => {
    const inputs = parseMarkdownToBlocks('# 标题\n\nfoo\nbar\n', 'nb')
    const paras = inputs.filter((i) => i.type === BlockType.Paragraph)
    expect(paras.length).toBe(2)
    expect(paras[0]!.content).toBe('foo')
    expect(paras[1]!.content).toBe('bar')
  })
})
