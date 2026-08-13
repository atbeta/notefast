/**
 * 文件建档：normalize / stage / create_doc_from_file / POST /import/file
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import importRouter from '../api/import'
import { createDocFromMarkdownFile,
  normalizeMarkdownFileContent,
  resolveImportTitle,
  titleFromFilename,
} from '../services/docFileImport'
import {
  _resetMarkdownStagesForTests,
  MAX_STAGE_CHUNK_BYTES,
  stageMarkdownChunk,
  takeStagedMarkdown,
} from '../services/markdownStage'
import { fetchDocBlocks } from '../store/blocks'
import { buildBlockTree, blocksToMarkdown } from '@notefast/core'

let testDir: string
let app: Hono
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-doc-file-import-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
  app = new Hono()
  app.route('/api/v1/import', importRouter)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  _resetMarkdownStagesForTests()
  getDb().query('DELETE FROM blocks').run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
})

describe('normalizeMarkdownFileContent', () => {
  test('字面量 \\n 在几乎无真换行时还原', () => {
    const raw = '# 标题\\n\\n第一段\\n\\n## 二\\n\\n第二段'
    const out = normalizeMarkdownFileContent(raw)
    expect(out).toContain('\n\n')
    expect(out).not.toContain('\\n')
    expect(out.split('\n').length).toBeGreaterThan(3)
  })

  test('已有真换行时不误伤含 \\n 的代码示例', () => {
    const raw = '# 标题\n\n代码里写 `\\n` 表示换行\n'
    const out = normalizeMarkdownFileContent(raw)
    expect(out).toContain('`\\n`')
  })
})

describe('title helpers', () => {
  test('filename → 标题', () => {
    expect(titleFromFilename('notes/hello-world.md')).toBe('hello-world')
  })
  test('resolve 优先显式 title', () => {
    expect(resolveImportTitle({
      title: '指定',
      filename: 'a.md',
      markdown: '# 忽略\n',
    })).toBe('指定')
  })
})

describe('markdownStage', () => {
  test('分块拼接', () => {
    const a = stageMarkdownChunk('# A\n\n')
    const b = stageMarkdownChunk('body\n', a.upload_id)
    expect(b.upload_id).toBe(a.upload_id)
    expect(takeStagedMarkdown(a.upload_id)).toBe('# A\n\nbody\n')
    expect(takeStagedMarkdown(a.upload_id)).toBeNull()
  })

  test('超大 chunk 拒绝', () => {
    const big = 'x'.repeat(MAX_STAGE_CHUNK_BYTES + 1)
    expect(() => stageMarkdownChunk(big)).toThrow(/65536|拆分/)
  })
})

describe('createDocFromMarkdownFile', () => {
  test('content 解析为多 block', () => {
    const md = `# 忽略重复标题

段一

## 小节

段二
`
    const r = createDocFromMarkdownFile(getDb(), {
      notebookId,
      content: md,
      title: '忽略重复标题',
    })
    expect(r.parsedCount).toBeGreaterThanOrEqual(2)
    const tree = buildBlockTree(fetchDocBlocks(getDb(), r.docId))
    const out = blocksToMarkdown(tree)
    expect(out).toContain('段一')
    expect(out).toContain('段二')
  })

  test('upload_id 路径', () => {
    const { upload_id } = stageMarkdownChunk('hello\n\nworld\n')
    const r = createDocFromMarkdownFile(getDb(), {
      notebookId,
      uploadId: upload_id,
      filename: 't.md',
    })
    expect(r.title).toBe('t')
    expect(r.parsedCount).toBeGreaterThanOrEqual(1)
  })
})

describe('POST /import/file', () => {
  test('multipart 建档', async () => {
    const md = '# 文件导入\n\n段落 A\n\n段落 B\n'
    const form = new FormData()
    form.set('notebook_id', notebookId)
    form.set('file', new File([md], 'file-import.md', { type: 'text/markdown' }))
    const res = await app.fetch(new Request('http://localhost/api/v1/import/file', {
      method: 'POST',
      body: form,
    }))
    expect(res.status).toBe(201)
    const body = await res.json() as { doc: { id: string; content: string }; block_count: number }
    expect(body.doc.content).toBe('文件导入')
    expect(body.block_count).toBeGreaterThanOrEqual(2)
  })
})

describe('POST /import/docx', () => {
  /** 用 jszip（mammoth 依赖，已随安装）构造最小 docx：真实 Heading1 + 段落 */
  async function makeDocx(): Promise<ArrayBuffer> {
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
    zip.folder('_rels')!.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
    zip.folder('word')!.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Word 标题</w:t></w:r></w:p>
    <w:p><w:r><w:t>Word 正文内容</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`)
    return new Uint8Array(await zip.generateAsync({ type: 'uint8array' })).buffer as ArrayBuffer
  }

  test('docx → markdown 入库（mammoth 转换）', async () => {
    const { initAssetStore } = await import('../assets/store')
    initAssetStore(testDir)
    const docx = await makeDocx()
    const form = new FormData()
    form.set('notebook_id', notebookId)
    form.set('file', new File([docx], 'word-doc.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
    const res = await app.fetch(new Request('http://localhost/api/v1/import/docx', {
      method: 'POST',
      body: form,
    }))
    expect(res.status).toBe(201)
    const body = await res.json() as { doc: { id: string }; block_count: number }
    const rows = fetchDocBlocks(getDb(), body.doc.id)
    const content = rows.map((r) => r.content).join('\n')
    expect(content).toContain('Word 标题')
    expect(content).toContain('Word 正文内容')
  })

  test('非 docx 内容返回 400', async () => {
    const form = new FormData()
    form.set('notebook_id', notebookId)
    form.set('file', new File(['这不是 zip'], 'bad.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
    const res = await app.fetch(new Request('http://localhost/api/v1/import/docx', {
      method: 'POST',
      body: form,
    }))
    expect(res.status).toBe(400)
  })
})
