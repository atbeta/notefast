/**
 * vault 图片落盘（RFC 0006 / U-13）
 *
 * 约定：图片进笔记同名的资源夹 `<笔记名>.assets/`，正文引用相对路径。
 * 覆盖：路径推导、命名与去重、mime → 扩展名、上传端点（vault / db / 未知 doc 三条路）。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import { initAssetStore } from '../assets/store'
import { DEFAULT_VAULT_IGNORE, type VaultConfig } from '../vault/config'
import { createVaultRuntime, setActiveVaultRuntime, type VaultRuntime } from '../vault'
import { noteAssetDirRelPath, writeVaultImage } from '../vault/images'
import { getVaultFileByPath } from '../store/vaultFiles'
import assetsRouter from '../api/assets'

let dataDir: string
let vaultDir: string
let notebookId: string
let runtime: VaultRuntime | null = null
let app: Hono

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

function makeConfig(root: string): VaultConfig {
  return {
    root,
    ignore: [...DEFAULT_VAULT_IGNORE],
    watch: false,
    writeback: true,
    stabilityMs: 50,
    usePolling: true,
    pollingSource: 'env',
    pollIntervalMs: 50,
    reconcileMinutes: 0,
  }
}

function writeVault(rel: string, content: string): void {
  const abs = join(vaultDir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  Bun.write(abs, content)
}

beforeAll(() => {
  dataDir = mkdtempSync(join('/tmp', 'notefast-vault-img-'))
  const result = initDb(dataDir)
  notebookId = result.notebookId
  // 退回资源库那条路要写 data/media：bun test 共享进程，不能指望别的测试文件先初始化过
  initAssetStore(dataDir)
  vaultDir = mkdtempSync(join('/tmp', 'notefast-vault-img-files-'))
  app = new Hono()
  app.route('/api/v1/assets', assetsRouter)
})

afterAll(() => {
  setActiveVaultRuntime(null)
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(vaultDir, { recursive: true, force: true })
})

beforeEach(() => {
  setActiveVaultRuntime(null)
  runtime = null
  rmSync(vaultDir, { recursive: true, force: true })
  mkdirSync(vaultDir, { recursive: true })
})

async function startVault(): Promise<void> {
  runtime = createVaultRuntime({ db: getDb(), notebookId, config: makeConfig(vaultDir) })
  await runtime.start({ awaitReconcile: true })
  setActiveVaultRuntime(runtime)
}

async function upload(opts: { docId?: string; name?: string; bytes?: Uint8Array }) {
  const headers: Record<string, string> = { 'Content-Type': 'image/png' }
  if (opts.name) headers['X-File-Name'] = encodeURIComponent(opts.name)
  const url = opts.docId ? `/api/v1/assets?doc_id=${encodeURIComponent(opts.docId)}` : '/api/v1/assets'
  const res = await app.request(url, {
    method: 'POST',
    headers,
    // Uint8Array 在运行时是合法 BodyInit（Bun / undici），TS 的 DOM 类型没收录
    body: (opts.bytes ?? PNG) as unknown as BodyInit,
  })
  return { status: res.status, body: (await res.json()) as { ref: string; url: string; id: string } }
}

describe('noteAssetDirRelPath', () => {
  test('根目录与子目录里的笔记', () => {
    expect(noteAssetDirRelPath('a.md')).toBe('a.assets')
    expect(noteAssetDirRelPath('notes/a.md')).toBe('notes/a.assets')
    expect(noteAssetDirRelPath('notes/books/deep.md')).toBe('notes/books/deep.assets')
  })

  test('名字里有空格与中文也照常', () => {
    expect(noteAssetDirRelPath('我的 笔记.md')).toBe('我的 笔记.assets')
  })
})

describe('writeVaultImage', () => {
  test('扩展名由 mime 决定；引用相对笔记所在目录', () => {
    const r = writeVaultImage({
      root: vaultDir,
      noteRelPath: 'notes/a.md',
      fileName: 'photo.jpg',
      mime: 'image/jpeg',
      bytes: PNG,
    })
    // 文件名沿用用户给的名字（这里是 jpg），mime 只用来兜底没有文件名的情况
    expect(r.relPath).toBe('notes/a.assets/photo.jpg')
    expect(r.ref).toBe('a.assets/photo.jpg')
    expect(existsSync(join(vaultDir, r.relPath))).toBe(true)
  })

  test('没有文件名时按 mime 起名', () => {
    const r = writeVaultImage({
      root: vaultDir,
      noteRelPath: 'a.md',
      fileName: null,
      mime: 'image/png',
      bytes: PNG,
    })
    expect(r.relPath).toBe('a.assets/image.png')
    // 根目录笔记：引用必须是 `a.assets/image.png`（只写 image.png 会碎图）
    expect(r.ref).toBe('a.assets/image.png')
  })

  test('重名自动加序号，不覆盖已有文件', () => {
    const first = writeVaultImage({ root: vaultDir, noteRelPath: 'b.md', fileName: 'x.png', mime: 'image/png', bytes: PNG })
    const second = writeVaultImage({ root: vaultDir, noteRelPath: 'b.md', fileName: 'x.png', mime: 'image/png', bytes: PNG })
    const third = writeVaultImage({ root: vaultDir, noteRelPath: 'b.md', fileName: 'x.png', mime: 'image/png', bytes: PNG })
    expect([first.relPath, second.relPath, third.relPath]).toEqual([
      'b.assets/x.png',
      'b.assets/x-2.png',
      'b.assets/x-3.png',
    ])
    expect(readdirSync(join(vaultDir, 'b.assets')).sort()).toEqual(['x-2.png', 'x-3.png', 'x.png'])
  })

  test('文件名里的路径分隔与非法字符被清理（写不出 vault）', () => {
    const r = writeVaultImage({
      root: vaultDir,
      noteRelPath: 'c.md',
      fileName: '../../evil.png',
      mime: 'image/png',
      bytes: PNG,
    })
    // 只允许「资源夹 + 文件名」两段：没有额外层级，也没有 `..` 段
    const parts = r.relPath.split('/')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toBe('c.assets')
    expect(parts[1]).not.toMatch(/^\./)
    expect(existsSync(join(vaultDir, 'evil.png'))).toBe(false)
    expect(existsSync(join(vaultDir, r.relPath))).toBe(true)
  })

  test('两篇笔记的资源夹互不干扰', () => {
    const a = writeVaultImage({ root: vaultDir, noteRelPath: 'notes/a.md', fileName: 'p.png', mime: 'image/png', bytes: PNG })
    const b = writeVaultImage({ root: vaultDir, noteRelPath: 'notes/b.md', fileName: 'p.png', mime: 'image/png', bytes: PNG })
    expect(a.relPath).toBe('notes/a.assets/p.png')
    expect(b.relPath).toBe('notes/b.assets/p.png')
  })
})

describe('POST /assets 的 doc_id', () => {
  test('vault 笔记：写进资源夹，返回相对引用（不是 asset:）', async () => {
    writeVault('notes/a.md', '# a\n\nbody\n')
    await startVault()
    const row = getVaultFileByPath(getDb(), notebookId, 'notes/a.md')!
    const mediaDir = join(dataDir, 'media')
    const mediaBefore = existsSync(mediaDir) ? readdirSync(mediaDir).length : 0

    const res = await upload({ docId: row.doc_id, name: '图 1.png' })
    expect(res.status).toBe(201)
    expect(res.body.ref).toBe('a.assets/图 1.png')
    expect(res.body.ref.startsWith('asset:')).toBe(false)
    expect(existsSync(join(vaultDir, 'notes', 'a.assets', '图 1.png'))).toBe(true)
    // 图片不进 data/media（这正是本设计的目的：文件在用户文件夹里）
    expect(existsSync(mediaDir) ? readdirSync(mediaDir).length : 0).toBe(mediaBefore)
  })

  test('没有 doc_id：走原来的资源库（db 模式行为不变）', async () => {
    await startVault()
    const res = await upload({ name: 'p.png' })
    expect(res.status).toBe(201)
    expect(res.body.ref.startsWith('asset:')).toBe(true)
  })

  test('doc_id 找不到映射（例如 db notebook 的文档）：退回资源库', async () => {
    await startVault()
    // 用与其它用例不同的字节：资源库按内容寻址去重，同字节会返回 200 + dedup
    const res = await upload({
      docId: '00000000-0000-4000-8000-000000000000',
      name: 'p.png',
      bytes: new Uint8Array([...PNG, 0x42]),
    })
    expect(res.status).toBe(201)
    expect(res.body.ref.startsWith('asset:')).toBe(true)
  })

  test('非图片仍然拒绝', async () => {
    await startVault()
    const res = await app.request('/api/v1/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: PNG,
    })
    expect(res.status).toBe(400)
  })
})
