/**
 * 新建文档的落盘目录（RFC 0005 / U-10）
 *
 * `POST /docs` 与 `POST /import/markdown` 支持 `dir`：vault 模式下文件落到该目录，
 * 越界路径忽略、db 模式忽略。链路是 `dir` → `properties.vault_hint_path` → 写回。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb } from '../db'
import { DEFAULT_VAULT_IGNORE, type VaultConfig } from '../vault/config'
import {
  createVaultRuntime,
  setActiveVaultRuntime,
  type VaultRuntime,
} from '../vault'
import { startVaultWriteback, type VaultWriteback } from '../vault/writeback'
import docsRouter from '../api/docs'
import importRouter from '../api/import'

let dataDir: string
let vaultDir: string
let notebookId: string
let runtime: VaultRuntime | null = null
let writeback: VaultWriteback | null = null
let app: Hono

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

/**
 * 直接驱动写回，而不是等 doc 事件。
 *
 * 事件链是 plugin hook → docEvents → writeback，由 createApp 装配；本用例只关心
 * 「API 收下 dir → 落成 vault_hint_path → 写回按它落盘」这一段，直接调 handle 更稳。
 */
async function writebackNow(docId: string): Promise<void> {
  if (!writeback) throw new Error('writeback 未启动')
  await writeback.handle({ doc_id: docId, kind: 'created', at: new Date().toISOString() })
}

async function startVault(): Promise<void> {
  runtime = createVaultRuntime({ db: (await import('../db')).getDb(), notebookId, config: makeConfig(vaultDir) })
  await runtime.start({ awaitReconcile: true })
  setActiveVaultRuntime(runtime)
  writeback = startVaultWriteback(runtime.ctx)
}

function stopVault(): void {
  writeback?.stop()
  writeback = null
  setActiveVaultRuntime(null)
  runtime = null
}

beforeAll(() => {
  dataDir = mkdtempSync(join('/tmp', 'notefast-vault-createdir-'))
  const result = initDb(dataDir)
  notebookId = result.notebookId
  vaultDir = mkdtempSync(join('/tmp', 'notefast-vault-createdir-files-'))
  app = new Hono()
  app.route('/docs', docsRouter)
  app.route('/import', importRouter)
})

afterAll(() => {
  stopVault()
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(vaultDir, { recursive: true, force: true })
})

beforeEach(() => {
  stopVault()
  rmSync(vaultDir, { recursive: true, force: true })
  mkdirSync(vaultDir, { recursive: true })
})

async function createDoc(body: Record<string, unknown>): Promise<{ status: number; id: string }> {
  const res = await app.request('/docs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notebook_id: notebookId, ...body }),
  })
  const json = (await res.json()) as { id?: string }
  return { status: res.status, id: json.id ?? '' }
}

describe('POST /docs 的 dir', () => {
  test('vault 模式：文件落到指定目录', async () => {
    await startVault()
    const { status, id } = await createDoc({ title: '子目录笔记', dir: 'notes/books' })
    expect(status).toBe(201)
    await writebackNow(id)
    expect(existsSync(join(vaultDir, 'notes', 'books', '子目录笔记.md'))).toBe(true)
    expect(existsSync(join(vaultDir, '子目录笔记.md'))).toBe(false)
  })

  test('缺省 dir：落在 vault 根', async () => {
    await startVault()
    const { id } = await createDoc({ title: '根目录笔记' })
    await writebackNow(id)
    expect(existsSync(join(vaultDir, '根目录笔记.md'))).toBe(true)
  })

  test('越界 dir 被忽略：仍落根目录，不报错', async () => {
    await startVault()
    const { status, id } = await createDoc({ title: '越界测试', dir: '../outside' })
    expect(status).toBe(201)
    await writebackNow(id)
    expect(existsSync(join(vaultDir, '越界测试.md'))).toBe(true)
  })

  test('绝对路径 dir 被忽略：仍落根目录', async () => {
    await startVault()
    const { id } = await createDoc({ title: '绝对路径', dir: '/etc/notes' })
    await writebackNow(id)
    expect(existsSync(join(vaultDir, '绝对路径.md'))).toBe(true)
  })
})

describe('POST /import/markdown 的 dir', () => {
  test('vault 模式：带正文导入同样落到指定目录', async () => {
    await startVault()
    const res = await app.request('/import/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebook_id: notebookId,
        title: '导入到子目录',
        markdown: '正文一段\n',
        dir: 'inbox/2026',
      }),
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as { doc: { id: string } }
    await writebackNow(created.doc.id)
    expect(existsSync(join(vaultDir, 'inbox', '2026', '导入到子目录.md'))).toBe(true)
  })

  test('越界 dir：退回根目录并照常导入', async () => {
    await startVault()
    const res = await app.request('/import/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebook_id: notebookId,
        title: '导入越界',
        markdown: 'body\n',
        dir: '/etc/passwd',
      }),
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as { doc: { id: string } }
    await writebackNow(created.doc.id)
    expect(existsSync(join(vaultDir, '导入越界.md'))).toBe(true)
  })
})
