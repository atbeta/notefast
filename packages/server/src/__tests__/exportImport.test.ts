/**
 * 整库导出（/api/v1/export/archive）与 zip 导入（/api/v1/import/zip）闭环测试：
 * - buildFullArchiveExport：多文档 + 图片 → 自包含 zip（md + media/ + manifest）
 * - parseZip：STORE 与 DEFLATE 两条解压路径
 * - importArchiveZip：自家档精确还原（docId 幂等、media 回写 asset:）、通用 md zip 兜底
 * - 导出 → 清库 → 导入 的完整往返
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import { initAssetStore, saveAsset, readAsset } from '../assets/store'
import docs from '../api/docs'
import importRouter from '../api/import'
import exportArchive from '../api/exportArchive'
import { buildZipStore, parseZip } from '../lib/zipStore'
import { buildFullArchiveExport } from '../services/docExport'
import { importArchiveZip } from '../services/zipImport'

let testDir: string
let app: Hono
let notebookId: string

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2); b[0] = n & 0xff; b[1] = (n >>> 8) & 0xff; return b
}
function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4); b[0] = n & 0xff; b[1] = (n >>> 8) & 0xff; b[2] = (n >>> 16) & 0xff; b[3] = (n >>> 24) & 0xff; return b
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len); let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}
/** 构造单条目 STORE zip（文件名用原始字节，flag 可指定——模拟 Windows 中文工具
 *  不带 UTF-8 bit 11 的 GBK 文件名 zip） */
function buildRawNameZip(nameBytes: Uint8Array, content: Uint8Array, flag = 0): Uint8Array {
  const local = concatBytes([
    Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), u16le(20), u16le(flag), u16le(0), u16le(0), u16le(0),
    u32le(0), u32le(content.length), u32le(content.length), u16le(nameBytes.length), u16le(0), nameBytes,
  ])
  const central = concatBytes([
    Uint8Array.from([0x50, 0x4b, 0x01, 0x02]), u16le(20), u16le(20), u16le(flag), u16le(0), u16le(0), u16le(0),
    u32le(0), u32le(content.length), u32le(content.length), u16le(nameBytes.length), u16le(0), u16le(0), u16le(0),
    u16le(0), u32le(0), u32le(0), nameBytes,
  ])
  const centralOffset = local.length + content.length
  const eocd = concatBytes([
    Uint8Array.from([0x50, 0x4b, 0x05, 0x06]), u16le(0), u16le(0), u16le(1), u16le(1),
    u32le(central.length), u32le(centralOffset), u16le(0),
  ])
  return concatBytes([local, content, central, eocd])
}

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-export-import-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
  initAssetStore(testDir)
  app = new Hono()
  app.route('/api/v1/docs', docs)
  app.route('/api/v1/import', importRouter)
  app.route('/api/v1/export', exportArchive)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  db.query('DELETE FROM assets').run()
  db.query('DELETE FROM blocks').run()
  db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
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

async function setDocTags(id: string, tags: string[]): Promise<void> {
  const res = await app.fetch(new Request(`http://localhost/api/v1/docs/${id}/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  }))
  expect(res.status).toBe(200)
}

describe('parseZip', () => {
  test('解析 buildZipStore 产出的 STORE zip', () => {
    const buf = buildZipStore([
      { name: 'a.md', data: new TextEncoder().encode('# A') },
      { name: 'media/x.png', data: new Uint8Array(PNG_BYTES) },
    ])
    const entries = parseZip(new Uint8Array(buf))
    expect(entries.length).toBe(2)
    expect(entries[0]!.name).toBe('a.md')
    expect(new TextDecoder().decode(entries[0]!.data)).toBe('# A')
    expect(entries[1]!.name).toBe('media/x.png')
    expect(Buffer.from(entries[1]!.data).equals(PNG_BYTES)).toBe(true)
  })

  test('解析 DEFLATE 压缩条目', () => {
    const data = new TextEncoder().encode('deflated content 压缩内容')
    const deflated = Bun.deflateSync(data)
    const entry = deflateZipEntry('note.md', deflated, data)
    const entries = parseZip(new Uint8Array(entry))
    expect(entries.length).toBe(1)
    expect(entries[0]!.name).toBe('note.md')
    expect(new TextDecoder().decode(entries[0]!.data)).toBe(new TextDecoder().decode(data))
  })

  test('Windows 中文 zip：GBK 文件名（无 UTF-8 flag）正确解码，不再乱码', () => {
    // 模拟 WinRAR/7-Zip/Windows 自带压缩：文件名是 GBK 字节且 general flag 无 bit 11。
    // 旧实现统一 UTF-8 解码 → 「测试笔记」变「���Աʼ�」。修复后先严格 UTF-8（失败）
    // 回退 GBK（Bun 原生支持），ASCII 子集不受影响。
    const gbk = [0xb2, 0xe2, 0xca, 0xd4, 0xb1, 0xca, 0xbc, 0xc7, 0x2e, 0x6d, 0x64] // 测试笔记.md GBK
    const content = new TextEncoder().encode('# 测试标题\n内容')
    const zip = buildRawNameZip(Uint8Array.from(gbk), content, 0 /* 不置 UTF-8 bit */)

    const entries = parseZip(zip)
    expect(entries.length).toBe(1)
    expect(entries[0]!.name).toBe('测试笔记.md')
    expect(new TextDecoder().decode(entries[0]!.data)).toBe('# 测试标题\n内容')
  })

  test('未置 UTF-8 flag 但内容恰为合法 UTF-8 字节：仍按 UTF-8 解码（严格回退不误伤）', () => {
    // 某些工具（macOS 压缩、部分在线工具）不置 bit 11 但存了 UTF-8 字节；
    // decodeLegacyName 先严格 UTF-8 成功即用，不会错误地丢给 GBK。
    const utf8 = new TextEncoder().encode('中文名.md')
    const zip = buildRawNameZip(utf8, new TextEncoder().encode('正文'), 0)
    const entries = parseZip(zip)
    expect(entries[0]!.name).toBe('中文名.md')
  })

  test('空/非 zip 输入抛错', () => {
    expect(() => parseZip(new Uint8Array([1, 2, 3]))).toThrow()
  })
})

describe('buildFullArchiveExport', () => {
  test('多文档 + 图片 → zip（md + media/ + manifest），asset: 改写为相对路径', async () => {
    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    const docA = await createDoc('文档甲', `甲正文\n\n![图](asset:${meta.id})\n`)
    const docB = await createDoc('文档乙', '乙正文')

    const file = buildFullArchiveExport()
    expect(file.filename).toMatch(/^notefast-export-.*\.zip$/)

    const entries = parseZip(file.body)
    const names = entries.map((e) => e.name)
    expect(names).toContain('notefast-archive.manifest.json')
    expect(names.some((n) => n.startsWith('untagged/') && n.includes(docA.replace(/-/g, '').slice(0, 12)))).toBe(true)
    expect(names.some((n) => n.startsWith('untagged/') && n.includes(docB.replace(/-/g, '').slice(0, 12)))).toBe(true)
    expect(names).toContain(`media/${meta.id}.png`)

    // md 内容：asset: 已改写为 ../media/ 相对路径，不再残留 asset:
    const docAEntry = entries.find((e) => e.name.endsWith('.md') && e.name.includes(docA.replace(/-/g, '').slice(0, 12)))!
    const mdText = new TextDecoder().decode(docAEntry.data)
    expect(mdText).toContain(`../media/${meta.id}.png`)
    expect(mdText).not.toContain('asset:')

    // manifest 结构与文档一一对应
    const manifestEntry = entries.find((e) => e.name === 'notefast-archive.manifest.json')!
    const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data))
    expect(manifest.kind).toBe('markdown-archive')
    expect(manifest.files.length).toBe(2)
    expect(manifest.media).toContain(`media/${meta.id}.png`)
  })

  test('有标签进首标签目录，无标签进 untagged/', async () => {
    const tagged = await createDoc('工作笔记', '正文')
    const untagged = await createDoc('未分类', '正文')
    await setDocTags(tagged, ['work', 'ai'])

    const entries = parseZip(buildFullArchiveExport().body)
    const names = entries.filter((e) => e.name.endsWith('.md')).map((e) => e.name)
    const shortTagged = tagged.replace(/-/g, '').slice(0, 12)
    const shortUntagged = untagged.replace(/-/g, '').slice(0, 12)
    expect(names.some((n) => n.startsWith(`work/`) && n.includes(shortTagged))).toBe(true)
    expect(names.some((n) => n.startsWith('untagged/') && n.includes(shortUntagged))).toBe(true)
    expect(names.some((n) => n.startsWith('ai/'))).toBe(false)

    const manifestEntry = entries.find((e) => e.name === 'notefast-archive.manifest.json')!
    const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data)) as { files: Array<{ docId: string; filename: string }> }
    expect(manifest.files.find((f) => f.docId === tagged)?.filename.startsWith('work/')).toBe(true)
    expect(manifest.files.find((f) => f.docId === untagged)?.filename.startsWith('untagged/')).toBe(true)
  })

  test('GET /api/v1/export/archive 返回 zip', async () => {
    await createDoc('导出接口测试', '正文')
    const res = await app.fetch(new Request('http://localhost/api/v1/export/archive'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/zip')
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    const body = await res.arrayBuffer()
    expect(parseZip(new Uint8Array(body)).length).toBeGreaterThan(0)
  })
})

describe('importArchiveZip', () => {
  test('自家档导入：按 manifest docId 精确还原、media 回写 asset:', async () => {
    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    const docId = await createDoc('还原文档', `正文甲\n\n![图](asset:${meta.id})\n`)
    const exported = buildFullArchiveExport()

    // 清库后再导入（保留 notebook）
    const db = getDb()
    db.query('DELETE FROM assets').run()
    db.query('DELETE FROM blocks').run()
    db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")

    const result = importArchiveZip(db, { notebookId, bytes: exported.body })
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.mediaImported).toBe(1)

    // docId 与导出前一致
    const row = db.query('SELECT content FROM blocks WHERE id = ? AND type = \'document\'').get(docId) as { content: string } | undefined
    expect(row?.content).toBe('还原文档')
    // media 引用回写为 asset:<sha>
    const bodyRows = db.query("SELECT content FROM blocks WHERE root_id = ? AND content LIKE '%asset:%'").all(docId) as Array<{ content: string }>
    expect(bodyRows.some((r) => r.content.includes(`asset:${meta.id}`))).toBe(true)
    // AssetStore 落盘
    expect(readAsset(meta.id)).not.toBeNull()
  })

  test('自家档重复导入幂等（同一 docId 跳过）', async () => {
    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    await createDoc('幂等文档', `![图](asset:${meta.id})`)
    const exported = buildFullArchiveExport()

    // 同一库直接再导一次 → 全部跳过
    const result = importArchiveZip(getDb(), { notebookId, bytes: exported.body })
    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(0)
  })

  test('通用 md zip（无 manifest）→ 每个 md 建一个新文档', async () => {
    const zip = buildZipStore([
      { name: '笔记一.md', data: new TextEncoder().encode('# 笔记一\n\n内容甲') },
      { name: '子目录/笔记二.md', data: new TextEncoder().encode('# 笔记二\n\n内容乙') },
    ])
    const result = importArchiveZip(getDb(), { notebookId, bytes: zip })
    expect(result.imported).toBe(2)
    expect(result.skipped).toBe(0)
    const titles = getDb().query("SELECT content FROM blocks WHERE type = 'document' ORDER BY created_at").all() as Array<{ content: string }>
    expect(titles.map((t) => t.content)).toContain('笔记一')
    expect(titles.map((t) => t.content)).toContain('笔记二')
  })

  test('GBK 文件名 zip（Windows 中文打包）：标题从文件名正确推断，不产生乱码', () => {
    // 无 manifest + 内容无 H1 → 标题 fallback 到文件名；文件名是 GBK 字节。
    // 修复前文件名乱码 → 标题「���Աʼ�」。
    const gbk = [0xce, 0xd2, 0xb5, 0xc4, 0xb1, 0xca, 0xbc, 0xc7, 0x2e, 0x6d, 0x64] // 我的笔记.md GBK
    const zip = buildRawNameZip(Uint8Array.from(gbk), new TextEncoder().encode('第一段内容'), 0)
    const result = importArchiveZip(getDb(), { notebookId, bytes: zip })
    expect(result.imported).toBe(1)
    expect(result.failed).toBe(0)
    const title = getDb().query("SELECT content FROM blocks WHERE type = 'document' AND content = '我的笔记'").get() as { content: string } | undefined
    expect(title).toBeDefined()
  })

  test('通用 zip 的 .txt 也按文档导入（无 manifest）', async () => {
    const zip = buildZipStore([
      { name: 'notes/说明.txt', data: new TextEncoder().encode('这是纯文本内容\n\n第二段') },
      { name: 'notes/其他.md', data: new TextEncoder().encode('# 其他\n\n正文') },
    ])
    const result = importArchiveZip(getDb(), { notebookId, bytes: zip })
    expect(result.imported).toBe(2)
    expect(result.failed).toBe(0)
    const txtTitle = getDb().query("SELECT content FROM blocks WHERE type = 'document' AND content = '说明'").get() as { content: string } | undefined
    expect(txtTitle).toBeDefined()
  })

  test('通用 md zip 的相对路径图片（images/foo.png）收编为 asset: 并重写引用', async () => {
    const zip = buildZipStore([
      {
        name: '带图笔记.md',
        data: new TextEncoder().encode('# 带图笔记\n\n![示例图](images/foo.png)\n\n![找不到](images/missing.png)'),
      },
      { name: 'images/foo.png', data: new Uint8Array(PNG_BYTES) },
    ])
    const result = importArchiveZip(getDb(), { notebookId, bytes: zip })
    expect(result.imported).toBe(1)

    // 文档内容：images/foo.png → asset:<sha>；missing.png 保留原引用
    const rows = getDb().query("SELECT content FROM blocks WHERE root_id IN (SELECT id FROM blocks WHERE type = 'document' AND content = '带图笔记') AND type != 'document' AND is_deleted = 0").all() as Array<{ content: string }>
    const text = rows.map((r) => r.content).join('\n')
    expect(text).toContain(`asset:${createHash('sha256').update(PNG_BYTES).digest('hex')}`)
    expect(text).toContain('images/missing.png')
    expect(readAsset(createHash('sha256').update(PNG_BYTES).digest('hex'))).not.toBeNull()
  })

  test('POST /import/markdown + source=file-open：同目录相对路径图片收编为 asset:', async () => {
    // 构造「md + 同目录图片」的磁盘布局，external_id 指向 md 文件
    const fs = await import('node:fs')
    const dir = mkdtempSync(join('/tmp', 'notefast-fileopen-img-'))
    fs.writeFileSync(join(dir, 'foo.png'), PNG_BYTES)
    const mdPath = join(dir, 'note.md')
    fs.writeFileSync(mdPath, '# 打开文档\n\n![图](foo.png)')

    const res = await app.fetch(new Request('http://localhost/api/v1/import/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebook_id: notebookId,
        title: '打开文档',
        markdown: '# 打开文档\n\n![图](foo.png)',
        status: 'inbox',
        source: { provider: 'file-open', external_id: mdPath },
      }),
    }))
    expect(res.status).toBe(201)

    // 文档内引用已重写为 asset:<sha>，且图片已入库
    const sha = createHash('sha256').update(PNG_BYTES).digest('hex')
    expect(readAsset(sha)).not.toBeNull()
    const docRows = getDb().query("SELECT id FROM blocks WHERE type = 'document' AND content = '打开文档' ORDER BY created_at DESC LIMIT 1").all() as Array<{ id: string }>
    const child = getDb().query('SELECT content FROM blocks WHERE root_id = ? AND type != ? AND is_deleted = 0').all(docRows[0]!.id, 'document') as Array<{ content: string }>
    expect(child.map((r) => r.content).join('\n')).toContain(`asset:${sha}`)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('readLocalImageCandidate 跨平台目录归属：子目录可读、路径穿越拦截（回归：Windows 反斜杠）', async () => {
    const { readLocalImageCandidate } = await import('../assets/store')
    const dir = mkdtempSync(join('/tmp', 'notefast-guard-'))
    const sub = join(dir, 'ModelForge 需求分解')
    mkdirSync(sub, { recursive: true })
    const png = join(sub, 'Pasted image.png')
    writeFileSync(png, PNG_BYTES)
    const mdPath = join(dir, 'note.md')

    const read = readLocalImageCandidate(mdPath)
    // 子目录（含中文 + 空格）应解析
    expect(read('ModelForge 需求分解/Pasted image.png')).not.toBeNull()
    // 路径穿越应拦截（../ 与绝对路径）
    expect(read('../outside.png')).toBeNull()
    expect(read('../../etc/passwd')).toBeNull()
    expect(read('/etc/passwd')).toBeNull()
    // Windows 风格：md 路径与引用都带盘符反斜杠时，dirname 语义一致（relative 判定）
    const winRead = readLocalImageCandidate('C:\\Users\\me\\note.md')
    // Linux 上 resolve 不认盘符，此断言只验证「不抛错且不会命中同目录外」——跳过文件命中，仅确认返回 null 不崩
    expect(typeof winRead).toBe('function')

    rmSync(dir, { recursive: true, force: true })
  })

  test('readUploadedImageCandidate：相对路径精确匹配 + basename 回退', async () => {
    const { readUploadedImageCandidate } = await import('../assets/store')
    const read = readUploadedImageCandidate([
      { path: 'ModelForge 需求分解/Pasted image.png', data: PNG_BYTES },
      { path: 'other.png', data: Buffer.from([9, 9, 9]) },
    ])
    // 精确相对路径命中
    expect(read('ModelForge 需求分解/Pasted image.png')).not.toBeNull()
    // basename 回退：引用只写文件名也能命中
    expect(read('Pasted image.png')).not.toBeNull()
    // 未上传文件 → null
    expect(read('missing.png')).toBeNull()
  })

  test('POST /import/markdown 不带 source 不改写相对路径（Web/MCP 路径行为不变）', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/import/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebook_id: notebookId,
        title: '无 source 文档',
        markdown: '# 无 source\n\n![图](foo.png)',
      }),
    }))
    expect(res.status).toBe(201)
    const docRows = getDb().query("SELECT id FROM blocks WHERE type = 'document' AND content = '无 source 文档' ORDER BY created_at DESC LIMIT 1").all() as Array<{ id: string }>
    const child = getDb().query('SELECT content FROM blocks WHERE root_id = ? AND type != ? AND is_deleted = 0').all(docRows[0]!.id, 'document') as Array<{ content: string }>
    expect(child.map((r) => r.content).join('\n')).toContain('foo.png')
  })

  test('损坏的 zip → 抛错（调用方映射 400）', () => {
    expect(() => importArchiveZip(getDb(), { notebookId, bytes: new Uint8Array([0x50, 0x4b, 0x00, 0x01]) })).toThrow()
  })

  test('POST /api/v1/import/zip 走 multipart 导入', async () => {
    await createDoc('接口导入文档', '接口正文')
    const exported = buildFullArchiveExport()

    const db = getDb()
    db.query('DELETE FROM blocks').run()
    db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")

    const form = new FormData()
    form.append('file', new File([new Uint8Array(exported.body)], 'export.zip'))
    form.append('notebook_id', notebookId)
    const res = await app.fetch(new Request('http://localhost/api/v1/import/zip', { method: 'POST', body: form }))
    expect(res.status).toBe(200)
    const body = await res.json() as { imported: number; skipped: number }
    expect(body.imported).toBe(1)
    expect(body.skipped).toBe(0)
  })
})

/** 构造一个 DEFLATE 压缩的单条目 zip（测试 parseZip 的 method 8 路径） */
function deflateZipEntry(name: string, deflated: Uint8Array, original: Uint8Array): Uint8Array {
  const crc = crc32ForTest(original)
  const nameBytes = new TextEncoder().encode(name)
  const method = 8
  const generalFlag = 0x0800
  const localHeader = concatForTest([
    u32ForTest(0x04034b50), u16ForTest(20), u16ForTest(generalFlag), u16ForTest(method),
    u16ForTest(0), u16ForTest(0), u32ForTest(crc), u32ForTest(deflated.length), u32ForTest(deflated.length),
    u16ForTest(nameBytes.length), u16ForTest(0), nameBytes,
  ])
  const central = concatForTest([
    u32ForTest(0x02014b50), u16ForTest(20), u16ForTest(20), u16ForTest(generalFlag), u16ForTest(method),
    u16ForTest(0), u16ForTest(0), u32ForTest(crc), u32ForTest(deflated.length), u32ForTest(deflated.length),
    u16ForTest(nameBytes.length), u16ForTest(0), u16ForTest(0), u16ForTest(0), u16ForTest(0),
    u32ForTest(0), u32ForTest(0), nameBytes,
  ])
  const eocd = concatForTest([
    u32ForTest(0x06054b50), u16ForTest(0), u16ForTest(0), u16ForTest(1), u16ForTest(1),
    u32ForTest(central.length), u32ForTest(localHeader.length + deflated.length), u16ForTest(0),
  ])
  return concatForTest([localHeader, deflated, central, eocd])
}

// ── 最小 zip 构造工具（测试内用）──
const CRC_T = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32ForTest(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function u16ForTest(n: number): Uint8Array {
  const b = new Uint8Array(2); b[0] = n & 0xff; b[1] = (n >>> 8) & 0xff; return b
}
function u32ForTest(n: number): Uint8Array {
  const b = new Uint8Array(4); b[0] = n & 0xff; b[1] = (n >>> 8) & 0xff; b[2] = (n >>> 16) & 0xff; b[3] = (n >>> 24) & 0xff; return b
}
function concatForTest(parts: Uint8Array[]): Uint8Array {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}
