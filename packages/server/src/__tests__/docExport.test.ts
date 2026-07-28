/**
 * 单文档导出（/docs/:id/export/file）与 zip STORE 工具测试
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import { initAssetStore, saveAsset } from '../assets/store'
import docs from '../api/docs'
import { buildZipStore, crc32 } from '../lib/zipStore'
import { buildDocExportFile, contentDispositionAttachment } from '../services/docExport'

let testDir: string
let app: Hono
let notebookId: string

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-doc-export-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
  initAssetStore(testDir)
  app = new Hono()
  app.route('/api/v1/docs', docs)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().query('DELETE FROM assets').run()
  getDb().query('DELETE FROM blocks').run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
})

async function createDoc(title: string, markdown: string): Promise<string> {
  const res = await app.fetch(new Request('http://localhost/api/v1/docs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notebook_id: notebookId, title, markdown }),
  }))
  const body = await res.json() as { id: string }
  expect(res.status).toBe(201)
  return body.id
}

describe('zipStore', () => {
  test('产出合法 ZIP 魔数且含明文内容', () => {
    const text = new TextEncoder().encode('hello zip')
    const buf = buildZipStore([{ name: 'a.md', data: text }])
    expect(buf[0]).toBe(0x50) // P
    expect(buf[1]).toBe(0x4b) // K
    expect(Buffer.from(buf).includes(Buffer.from('hello zip'))).toBe(true)
    expect(crc32(text)).toBeGreaterThan(0)
  })
})

describe('contentDispositionAttachment', () => {
  test('含中文时带 filename*', () => {
    const h = contentDispositionAttachment('测试笔记.md')
    expect(h).toContain("filename*=UTF-8''")
    expect(h).toContain(encodeURIComponent('测试笔记.md'))
  })
})

describe('buildDocExportFile / GET export/file', () => {
  test('无图文档 → markdown 文件', async () => {
    const id = await createDoc('纯文本笔记', '第一段\n\n第二段')
    const file = buildDocExportFile(id)
    expect(file).not.toBeNull()
    expect(file!.kind).toBe('markdown')
    expect(file!.filename).toMatch(/\.md$/)
    const text = new TextDecoder().decode(file!.body)
    expect(text).toContain('第一段')

    const res = await app.fetch(new Request(`http://localhost/api/v1/docs/${id}/export/file`))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/markdown')
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    const body = await res.text()
    expect(body).toContain('第二段')
  })

  test('有图文档 → zip，asset: 改写为 media/ 相对路径', async () => {
    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    const id = await createDoc('带图笔记', `配图说明\n\n![图](asset:${meta.id})\n`)
    const file = buildDocExportFile(id)
    expect(file).not.toBeNull()
    expect(file!.kind).toBe('zip')
    expect(file!.filename).toMatch(/\.zip$/)
    expect(file!.contentType).toBe('application/zip')

    const zip = Buffer.from(file!.body)
    expect(zip[0]).toBe(0x50)
    expect(zip[1]).toBe(0x4b)
    // MD 与媒体路径名应出现在 zip 中央/本地头
    expect(zip.includes(Buffer.from(`media/${meta.id}.png`))).toBe(true)
    expect(zip.includes(Buffer.from('asset:'))).toBe(false)
    expect(zip.includes(PNG_BYTES)).toBe(true)

    const res = await app.fetch(new Request(`http://localhost/api/v1/docs/${id}/export/file`))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/zip')
  })

  test('悬空 asset 引用 → 仍导出 markdown（不造空 zip）', async () => {
    const fake = createHash('sha256').update('missing').digest('hex')
    const id = await createDoc('断链图', `![x](asset:${fake})`)
    const file = buildDocExportFile(id)
    expect(file!.kind).toBe('markdown')
    const text = new TextDecoder().decode(file!.body)
    expect(text).toContain(`asset:${fake}`)
  })

  test('文档不存在 → 404', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/docs/no-such-doc/export/file'))
    expect(res.status).toBe(404)
  })
})
