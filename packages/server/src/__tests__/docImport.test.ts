import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { blocksToMarkdown, buildBlockTree } from '@notefast/core'
import type { BlockRow } from '@notefast/core'
import { initDb, closeDb, getDb } from '../db'
import { fetchDocBlocks } from '../dbQueries'
import { insertDocFromMarkdown, appendMarkdownToDoc } from '../services/docImport'

let testDir: string
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-docimport-test-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('appendMarkdownToDoc', () => {
  test('追加的 Markdown 解析为结构化 block 树（代码块/表格/标题/emoji）', () => {
    const db = getDb()
    const { docId } = insertDocFromMarkdown(db, {
      notebookId,
      title: '追加测试',
      markdown: '只有一段简单文本',
    })

    const { blockIds, parsedCount } = appendMarkdownToDoc(db, {
      docId,
      notebookId,
      markdown: [
        '## 补充章节',
        '',
        '含 emoji 的段落 🎉',
        '',
        '```ts',
        'const a = 1',
        '```',
        '',
        '| 列A | 列B |',
        '| --- | --- |',
        '| 1 | 2 |',
      ].join('\n'),
    })

    expect(parsedCount).toBeGreaterThan(1)
    expect(blockIds.length).toBe(parsedCount)

    const rows = db
      .query(`SELECT * FROM blocks WHERE root_id = ? AND is_deleted = 0 AND type != 'document' ORDER BY sort`)
      .all(docId) as BlockRow[]
    const types = rows.map((r) => r.type)
    expect(types).toContain('paragraph')
    expect(types).toContain('heading')
    expect(types).toContain('code')
    expect(types).toContain('table')

    // properties 保留（headingLevel / language），预览渲染依赖这些字段
    const heading = rows.find((r) => r.type === 'heading')!
    expect(JSON.parse(heading.properties).headingLevel).toBe(2)
    expect(heading.content).toBe('补充章节')
    const code = rows.find((r) => r.type === 'code')!
    expect(JSON.parse(code.properties).language).toBe('ts')
    expect(code.content).toBe('const a = 1')
    const para = rows.find((r) => r.type === 'paragraph' && r.content.includes('emoji'))!
    expect(para.content).toContain('🎉')
  })

  test('追加块 sort 接在现有子块之后，层级与嵌套正确', () => {
    const db = getDb()
    const { docId } = insertDocFromMarkdown(db, {
      notebookId,
      title: '排序测试',
      markdown: '第一段\n\n第二段',
    })

    appendMarkdownToDoc(db, {
      docId,
      notebookId,
      markdown: '## 章节\n\n章节下的段落',
    })

    const rows = db
      .query(`SELECT * FROM blocks WHERE root_id = ? AND is_deleted = 0 AND type != 'document' ORDER BY sort`)
      .all(docId) as BlockRow[]

    // 顶层块 sort 严格递增（追加的接在原有 0,1 之后）
    const topLevel = rows.filter((r) => r.parent_id === docId)
    expect(topLevel.map((r) => r.sort)).toEqual([0, 1, 2, 3])
    expect(topLevel[2].type).toBe('heading')
    expect(topLevel[2].content).toBe('章节')
    expect(topLevel[3].content).toBe('章节下的段落')
    expect(topLevel[3].level).toBe(1)

    // 缩进嵌套的列表项挂在父级下，level 递增
    appendMarkdownToDoc(db, {
      docId,
      notebookId,
      markdown: '- 父项\n  - 子项',
    })
    const rows2 = db
      .query(`SELECT * FROM blocks WHERE root_id = ? AND is_deleted = 0 AND type != 'document' ORDER BY sort`)
      .all(docId) as BlockRow[]
    const parent = rows2.find((r) => r.content === '父项')!
    const child = rows2.find((r) => r.content === '子项')!
    expect(child.parent_id).toBe(parent.id)
    expect(child.level).toBe(parent.level + 1)
  })

  test('追加后导出 Markdown 保留代码块与表格语法（round-trip）', () => {
    const db = getDb()
    const { docId } = insertDocFromMarkdown(db, {
      notebookId,
      title: '导出测试',
      markdown: '简单文本',
    })

    appendMarkdownToDoc(db, {
      docId,
      notebookId,
      markdown: '```js\nconsole.log(1)\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |',
    })

    const rows = fetchDocBlocks(db, docId)
    const tree = buildBlockTree(rows)
    const md = blocksToMarkdown(tree)
    expect(md).toContain('```js')
    expect(md).toContain('| a | b |')
  })
})
