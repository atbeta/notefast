/**
 * vault 巡检（RFC 0005 U-9）：未解析链接聚合、冲突副本清单、`.trash/` 清单。
 *
 * 端点部分用真实 runtime（有 vault 绑定与 ingest），纯函数部分单独测。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import { DEFAULT_VAULT_IGNORE, type VaultConfig } from '../vault/config'
import { createVaultRouter, createVaultRuntime, setActiveVaultRuntime, type VaultRuntime } from '../vault'
import { listVaultConflicts, listVaultTrash, CONFLICT_INFIX } from '../vault/inspect'

let dataDir: string
let vaultDir: string
let notebookId: string

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
  writeFileSync(abs, content, 'utf8')
}

async function startRuntime(): Promise<{ runtime: VaultRuntime; app: Hono }> {
  const runtime = createVaultRuntime({ db: getDb(), notebookId, config: makeConfig(vaultDir) })
  await runtime.start({ awaitReconcile: true })
  const app = new Hono()
  app.route('/api/v1/vault', createVaultRouter(() => runtime))
  return { runtime, app }
}

beforeAll(() => {
  dataDir = mkdtempSync(join('/tmp', 'notefast-vault-inspect-'))
  const result = initDb(dataDir)
  notebookId = result.notebookId
  vaultDir = mkdtempSync(join('/tmp', 'notefast-vault-inspect-files-'))
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(vaultDir, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(vaultDir, { recursive: true, force: true })
  mkdirSync(vaultDir, { recursive: true })
})

describe('GET /vault/links/unresolved', () => {
  test('按目标名聚合，附来源文件；目标存在后自动消失', async () => {
    writeVault('src/a.md', '# A\n\n见 [[未来的笔记]] 与 [[另一篇]]\n')
    writeVault('src/b.md', '# B\n\n也见 [[未来的笔记]]\n')
    const { app } = await startRuntime()

    const res = (await (await app.request('/api/v1/vault/links/unresolved')).json()) as {
      total: number
      targets: Array<{ target_name: string; count: number; sources: Array<{ rel_path: string | null }> }>
    }
    expect(res.total).toBe(3)
    const future = res.targets.find((t) => t.target_name === '未来的笔记')!
    expect(future.count).toBe(2)
    expect(future.sources.map((s) => s.rel_path).sort()).toEqual(['src/a.md', 'src/b.md'])
    const other = res.targets.find((t) => t.target_name === '另一篇')!
    expect(other.count).toBe(1)
  })

  test('目标文件出现后不再计入', async () => {
    writeVault('src/a.md', '# A\n\n见 [[会有]]\n')
    const { app, runtime } = await startRuntime()
    const before = (await (await app.request('/api/v1/vault/links/unresolved')).json()) as { total: number }
    expect(before.total).toBe(1)

    writeVault('会有.md', '# 会有\n\n来了\n')
    await runtime.ingest('会有.md')
    const after = (await (await app.request('/api/v1/vault/links/unresolved')).json()) as { total: number }
    expect(after.total).toBe(0)
  })

  test('未启用 vault → 404', async () => {
    const app = new Hono()
    app.route('/api/v1/vault', createVaultRouter(() => null))
    expect((await app.request('/api/v1/vault/links/unresolved')).status).toBe(404)
  })
})

describe('GET /vault/conflicts', () => {
  test('只捞冲突副本，并尽力还原原始路径', async () => {
    writeVault('notes/plan.md', '# plan\n\nbody\n')
    writeVault(`notes/plan${CONFLICT_INFIX}20260910-120000.md`, '# plan\n\n另一份\n')
    const { app } = await startRuntime()

    const res = (await (await app.request('/api/v1/vault/conflicts')).json()) as {
      count: number
      files: Array<{ rel_path: string; doc_id: string; original_path: string | null }>
    }
    expect(res.count).toBe(1)
    expect(res.files[0]!.rel_path).toBe(`notes/plan${CONFLICT_INFIX}20260910-120000.md`)
    expect(res.files[0]!.original_path).toBe('notes/plan.md')
    expect(res.files[0]!.doc_id).toBeTruthy()
  })

  test('没有冲突副本时：count=0，空列表', async () => {
    writeVault('a.md', '# A\n')
    const { app } = await startRuntime()
    const res = (await (await app.request('/api/v1/vault/conflicts')).json()) as { count: number }
    expect(res.count).toBe(0)
  })
})

describe('GET /vault/trash', () => {
  test('列出 .trash/ 下的文件（跳过隐藏项与目录本身）', async () => {
    writeVault('gone.md', '# gone\n')
    writeVault('.trash/gone.md', '# gone\n')
    writeVault('.trash/nested/deep.md', '# deep\n')
    writeVault('.trash/.hidden/secret.md', '# secret\n')
    const { app } = await startRuntime()

    const res = (await (await app.request('/api/v1/vault/trash')).json()) as {
      count: number
      files: Array<{ path: string; name: string; size: number }>
    }
    const paths = res.files.map((f) => f.path).sort()
    expect(paths).toEqual(['gone.md', 'nested/deep.md'])
    expect(res.count).toBe(2)
    expect(res.files.every((f) => f.size >= 0)).toBe(true)
  })

  test('没有 .trash/ 目录：空列表而不是报错', async () => {
    writeVault('a.md', '# A\n')
    const { app } = await startRuntime()
    expect(await (await app.request('/api/v1/vault/trash')).json()).toEqual({
      count: 0,
      files: [],
      truncated: false,
    })
  })
})

describe('listVaultTrash / listVaultConflicts 纯函数', () => {
  test('listVaultTrash 尊重 limit 并给出 truncated', async () => {
    for (let i = 0; i < 5; i++) writeVault(`.trash/f${i}.md`, `# f${i}\n`)
    const res = await listVaultTrash(vaultDir, { limit: 2 })
    expect(res.count).toBe(2)
    expect(res.truncated).toBe(true)
  })

  test('listVaultConflicts 只认约定命名（中缀前必须是 `.`）', async () => {
    writeVault('plain.md', '# p\n')
    // 名字里含 notefast-conflict 但不是 `.notefast-conflict-` 中缀：不算冲突副本
    writeVault('has-notefast-conflict-inside.md', '# x\n')
    writeVault(`real${CONFLICT_INFIX}20260910-130000.md`, '# r\n')
    await startRuntime()

    const res = listVaultConflicts(getDb(), notebookId)
    const paths = res.files.map((f) => f.rel_path)
    expect(paths).toContain(`real${CONFLICT_INFIX}20260910-130000.md`)
    expect(paths).not.toContain('has-notefast-conflict-inside.md')
    expect(paths).not.toContain('plain.md')
  })
})

describe('永久删除时的 vault 清理（discardTrashed）', () => {
  test('删掉 .trash/ 副本与映射行', async () => {
    writeVault('temp.md', '# temp\n')
    const { runtime } = await startRuntime()
    setActiveVaultRuntime(runtime)

    const docId = (await runtime.ingest('temp.md')).docId!
    expect(docId).toBeTruthy()
    // 模拟回收站：文件移到 .trash/，映射打 deleted_at
    const { getVaultFileByDocId } = await import('../store/vaultFiles')
    const { markVaultFileDeleted } = await import('../store/vaultFiles')
    mkdirSync(join(vaultDir, '.trash'), { recursive: true })
    writeFileSync(join(vaultDir, '.trash', 'temp.md'), '# temp\n')
    markVaultFileDeleted(getDb(), notebookId, 'temp.md')

    runtime.discardTrashed(docId)

    expect(getVaultFileByDocId(getDb(), docId)).toBeNull()
    expect(await listVaultTrash(vaultDir)).toMatchObject({ count: 0 })
    setActiveVaultRuntime(null)
  })
})
