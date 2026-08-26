/**
 * Markdown 影子副本：data/markdown/<首标签|untagged>/<slug>--<id12>.md
 * 单向（改文件不写回）；图片改写为 ../../media/<sha>，不复制 blob。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import { initAssetStore, saveAsset } from '../assets/store'
import { insertDocFromMarkdown } from '../services/docImport'
import { archiveRelPath } from '../sync/archive'
import { readTags } from '@notefast/core'
import { getDocById } from '../store/blocks'
import { publishDocChange, FLUSH_MS } from '../services/docEvents'
import {
  applyShadowConfig,
  fullSyncShadow,
  getShadowConfig,
  initShadowMarkdown,
  removeShadowDoc,
  rewriteShadowAssetRefs,
  stopShadowMarkdown,
  writeShadowDoc,
  _resetShadowMarkdownForTests,
} from '../services/shadowMarkdown'
import instanceRouter from '../api/instance'

let testDir: string
let notebookId: string
let app: Hono

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const waitFlush = () => new Promise((r) => setTimeout(r, FLUSH_MS + 150))
/** 后台 fullSync 用 setTimeout(0)，给事件循环一拍再断言 */
const waitDeferredFullSync = () => new Promise((r) => setTimeout(r, 50))

function markdownRoot(): string {
  return join(testDir, 'markdown')
}

function createDoc(title: string, markdown: string, tags?: string[]): string {
  const { docId } = insertDocFromMarkdown(getDb(), {
    notebookId,
    title,
    markdown,
    tags,
  })
  return docId
}

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-shadow-md-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
  initAssetStore(testDir)
  initShadowMarkdown(testDir)
  app = new Hono()
  app.route('/api/v1/instance', instanceRouter)
})

afterAll(() => {
  stopShadowMarkdown()
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().query('DELETE FROM assets').run()
  getDb().query('DELETE FROM blocks').run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
  rmSync(markdownRoot(), { recursive: true, force: true })
  rmSync(join(testDir, 'shadow-markdown.config.json'), { force: true })
  _resetShadowMarkdownForTests()
  initShadowMarkdown(testDir)
})

describe('rewriteShadowAssetRefs', () => {
  test('已存在的 asset 改写为 ../../media/<sha>，不带扩展名', () => {
    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    const out = rewriteShadowAssetRefs(`见图 ![x](asset:${meta.id})`)
    expect(out).toBe(`见图 ![x](../../media/${meta.id})`)
  })

  test('悬空 asset 引用保持原样', () => {
    const missing = 'a'.repeat(64)
    const src = `![x](asset:${missing})`
    expect(rewriteShadowAssetRefs(src)).toBe(src)
  })
})

describe('writeShadowDoc', () => {
  test('无标签 → untagged/；有标签 → 首标签目录', () => {
    const untaggedId = createDoc('Hello World', '一段正文')
    const taggedId = createDoc('Hello World', '一段正文', ['work', 'ai'])
    const untagged = getDocById(getDb(), untaggedId)!
    const tagged = getDocById(getDb(), taggedId)!
    writeShadowDoc(untagged)
    writeShadowDoc(tagged)

    const untaggedRel = archiveRelPath('Hello World', untaggedId, [])
    const taggedRel = archiveRelPath('Hello World', taggedId, ['work', 'ai'])
    expect(untaggedRel.startsWith('untagged/')).toBe(true)
    expect(taggedRel.startsWith('work/')).toBe(true)
    expect(existsSync(join(markdownRoot(), untaggedRel))).toBe(true)
    expect(existsSync(join(markdownRoot(), taggedRel))).toBe(true)
    const body = readFileSync(join(markdownRoot(), taggedRel), 'utf-8')
    expect(body).toContain('一段正文')
    expect(body.startsWith('---\n')).toBe(true)
  })

  test('不把 media blob 复制进 markdown/', () => {
    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    const id = createDoc('带图', `![x](asset:${meta.id})`)
    writeShadowDoc(getDocById(getDb(), id)!)
    expect(existsSync(join(testDir, 'media', meta.id))).toBe(true)
    expect(existsSync(join(markdownRoot(), 'media'))).toBe(false)
    const rel = archiveRelPath('带图', id, [])
    expect(readFileSync(join(markdownRoot(), rel), 'utf-8')).toContain(`../../media/${meta.id}`)
  })

  test('首标签变化 → 删除旧路径文件', () => {
    const id = createDoc('笔记', '正文')
    writeShadowDoc(getDocById(getDb(), id)!)
    const oldRel = archiveRelPath('笔记', id, [])
    expect(existsSync(join(markdownRoot(), oldRel))).toBe(true)

    getDb().query('UPDATE blocks SET tags = ? WHERE id = ?').run(JSON.stringify(['work']), id)
    const next = getDocById(getDb(), id)!
    writeShadowDoc(next)
    const newRel = archiveRelPath(next.content || 'untitled', id, readTags(next))
    expect(existsSync(join(markdownRoot(), newRel))).toBe(true)
    expect(existsSync(join(markdownRoot(), oldRel))).toBe(false)
  })

  test('removeShadowDoc 删除影子文件', () => {
    const id = createDoc('将删', '正文')
    writeShadowDoc(getDocById(getDb(), id)!)
    const rel = archiveRelPath('将删', id, [])
    expect(existsSync(join(markdownRoot(), rel))).toBe(true)
    removeShadowDoc(id)
    expect(existsSync(join(markdownRoot(), rel))).toBe(false)
  })

  test('关闭后 writeShadowDoc 不再落盘', () => {
    applyShadowConfig({ enabled: false })
    const id = createDoc('关闭时', '正文')
    writeShadowDoc(getDocById(getDb(), id)!)
    const rel = archiveRelPath('关闭时', id, [])
    expect(existsSync(join(markdownRoot(), rel))).toBe(false)
  })
})

describe('fullSyncShadow / 默认开启', () => {
  test('无配置文件时默认 enabled', () => {
    expect(getShadowConfig().enabled).toBe(true)
    expect(existsSync(join(testDir, 'shadow-markdown.config.json'))).toBe(false)
  })

  test('全量同步写出全部未删除文档并清掉陈旧文件', () => {
    const keepId = createDoc('保留', 'a')
    const dropId = createDoc('将删', 'b')
    fullSyncShadow()
    const dropRel = archiveRelPath('将删', dropId, [])
    expect(existsSync(join(markdownRoot(), dropRel))).toBe(true)

    getDb().query('UPDATE blocks SET is_deleted = 1 WHERE id = ?').run(dropId)
    fullSyncShadow()
    expect(existsSync(join(markdownRoot(), dropRel))).toBe(false)
    const keepRel = archiveRelPath('保留', keepId, [])
    expect(existsSync(join(markdownRoot(), keepRel))).toBe(true)
  })

  test('init 立即返回，现有文档稍后才写出', async () => {
    const id = createDoc('后台同步', '正文')
    const rel = archiveRelPath('后台同步', id, [])
    rmSync(markdownRoot(), { recursive: true, force: true })
    _resetShadowMarkdownForTests()
    initShadowMarkdown(testDir)
    expect(existsSync(join(markdownRoot(), rel))).toBe(false)
    await waitDeferredFullSync()
    expect(existsSync(join(markdownRoot(), rel))).toBe(true)
  })

  test('重新打开影子不阻塞 applyShadowConfig', async () => {
    applyShadowConfig({ enabled: false })
    const id = createDoc('重开', '正文')
    const rel = archiveRelPath('重开', id, [])
    applyShadowConfig({ enabled: true })
    expect(existsSync(join(markdownRoot(), rel))).toBe(false)
    await waitDeferredFullSync()
    expect(existsSync(join(markdownRoot(), rel))).toBe(true)
  })

  test('stop 取消尚未执行的全量同步', async () => {
    const id = createDoc('取消', '正文')
    const rel = archiveRelPath('取消', id, [])
    rmSync(markdownRoot(), { recursive: true, force: true })
    _resetShadowMarkdownForTests()
    initShadowMarkdown(testDir)
    stopShadowMarkdown()
    await waitDeferredFullSync()
    expect(existsSync(join(markdownRoot(), rel))).toBe(false)
  })

  test('内容未变时 fullSync 不重写文件', () => {
    const id = createDoc('稳定', '正文')
    fullSyncShadow()
    const dest = join(markdownRoot(), archiveRelPath('稳定', id, []))
    const mtime1 = statSync(dest).mtimeMs
    fullSyncShadow()
    expect(statSync(dest).mtimeMs).toBe(mtime1)
  })
})

describe('docEvents 订阅', () => {
  test('created 事件写出影子文件', async () => {
    const id = createDoc('事件创建', 'hello')
    publishDocChange(id, 'created')
    await waitFlush()
    const rel = archiveRelPath('事件创建', id, [])
    expect(existsSync(join(markdownRoot(), rel))).toBe(true)
  })

  test('deleted 事件删除影子文件', async () => {
    const id = createDoc('事件删除', 'hello')
    writeShadowDoc(getDocById(getDb(), id)!)
    const rel = archiveRelPath('事件删除', id, [])
    publishDocChange(id, 'deleted')
    await waitFlush()
    expect(existsSync(join(markdownRoot(), rel))).toBe(false)
  })
})

describe('GET/PUT /api/v1/instance', () => {
  test('返回绝对 data_dir / markdown_dir，以及默认开启的影子开关', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/instance'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data_dir: string
      markdown_dir: string
      shadow_markdown_enabled: boolean
    }
    expect(body.data_dir).toBe(resolve(testDir))
    expect(body.markdown_dir).toBe(resolve(join(testDir, 'markdown')))
    expect(body.shadow_markdown_enabled).toBe(true)
  })

  test('PUT 可关闭影子副本', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/instance', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shadow_markdown_enabled: false }),
    }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { shadow_markdown_enabled: boolean }
    expect(body.shadow_markdown_enabled).toBe(false)
    expect(getShadowConfig().enabled).toBe(false)
  })
})
