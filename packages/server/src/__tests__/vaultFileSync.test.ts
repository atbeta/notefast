/**
 * vault 文件同步引擎（RFC 0004）—— 两个实例经一个 LocalFS 目标同步。
 *
 * 直接用裸 sqlite 承载 `vault_sync_state`（引擎只依赖那两张查询），
 * 避免 `getDb()` 单例妨碍「两个设备」的构造。
 */

import { Database } from 'bun:sqlite'
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalFsObjectStore } from '../storage/webdavStore'
import { DEFAULT_VAULT_IGNORE } from '../vault/config'
import { ensureVaultSyncMeta, isSyncableRelPath, pullVaultFiles, pushVaultFiles, readRemoteEntries, type FileSyncDeps } from '../vault/fileSync'
import * as m027 from '../migrations/027_vault_sync_state'

const PREFIX = 'sync/'

let rootA: string
let rootB: string
let storeDir: string
let dbA: Database
let dbB: Database
let vaultId: string

function makeDb(): Database {
  const db = new Database(':memory:')
  m027.up(db)
  return db
}

function deps(root: string, db: Database, deviceId: string): FileSyncDeps {
  return {
    store: createLocalFsObjectStore(storeDir),
    prefix: PREFIX,
    root,
    ignore: [...DEFAULT_VAULT_IGNORE],
    deviceId,
    db,
  }
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

/** A push → B pull 一轮 */
async function syncAtoB(): Promise<void> {
  await pushVaultFiles(deps(rootA, dbA, 'devA'))
  await pullVaultFiles(deps(rootB, dbB, 'devB'))
}

beforeEach(async () => {
  rootA = mkdtempSync(join(tmpdir(), 'nf-sync-a-'))
  rootB = mkdtempSync(join(tmpdir(), 'nf-sync-b-'))
  storeDir = mkdtempSync(join(tmpdir(), 'nf-sync-store-'))
  dbA = makeDb()
  dbB = makeDb()
  vaultId = crypto.randomUUID()
  await ensureVaultSyncMeta(createLocalFsObjectStore(storeDir), PREFIX, vaultId)
})

afterEach(() => {
  dbA.close()
  dbB.close()
  for (const dir of [rootA, rootB, storeDir]) rmSync(dir, { recursive: true, force: true })
})

describe('vault 文件同步：push / pull', () => {
  test('新建文件从 A 同步到 B；B 端索引无关（只文件层）', async () => {
    writeFile(rootA, 'a.md', '第一段\n')
    writeFile(rootA, 'notes/b.md', 'B 内容\n')
    await syncAtoB()
    expect(read(rootB, 'a.md')).toBe('第一段\n')
    expect(read(rootB, 'notes/b.md')).toBe('B 内容\n')
  })

  test('编辑 / 新建 / 删除 / 改名 都能收敛，删除进 .trash', async () => {
    writeFile(rootA, 'keep.md', '原始\n')
    writeFile(rootA, 'gone.md', '待删\n')
    writeFile(rootA, 'old.md', '要改名\n')
    await syncAtoB()
    expect(existsSync(join(rootB, 'gone.md'))).toBe(true)

    writeFile(rootA, 'keep.md', '改过\n')
    writeFile(rootA, 'new.md', '新文件\n')
    unlinkSync(join(rootA, 'gone.md'))
    renameSync(join(rootA, 'old.md'), join(rootA, 'renamed.md'))
    await syncAtoB()

    expect(read(rootB, 'keep.md')).toBe('改过\n')
    expect(read(rootB, 'new.md')).toBe('新文件\n')
    expect(existsSync(join(rootB, 'gone.md'))).toBe(false)
    expect(existsSync(join(rootB, '.trash', 'gone.md'))).toBe(true)
    expect(existsSync(join(rootB, 'old.md'))).toBe(false)
    expect(read(rootB, 'renamed.md')).toBe('要改名\n')
  })

  test('幂等：重复 push / pull 不产生新对象、不改文件', async () => {
    writeFile(rootA, 'x.md', '内容\n')
    await syncAtoB()
    const before = read(rootB, 'x.md')

    const push2 = await pushVaultFiles(deps(rootA, dbA, 'devA'))
    expect(push2.changed).toBe(0)
    expect(push2.uploaded_blobs).toBe(0)
    expect(push2.tombstones).toBe(0)

    const pull2 = await pullVaultFiles(deps(rootB, dbB, 'devB'))
    expect(pull2.applied).toBe(0)
    expect(pull2.deleted).toBe(0)
    expect(pull2.conflicts).toHaveLength(0)
    expect(read(rootB, 'x.md')).toBe(before)
  })

  test('双方都改同一文件 → 新者成为当前文件，旧者留冲突副本，两侧都有两版内容', async () => {
    writeFile(rootA, 'c.md', '基线\n')
    await syncAtoB()

    // A 后改（更新），B 先改（较旧）
    writeFile(rootB, 'c.md', 'B 的版本\n')
    const past = new Date(Date.now() - 60_000)
    const { utimesSync } = await import('node:fs')
    utimesSync(join(rootB, 'c.md'), past, past)
    writeFile(rootA, 'c.md', 'A 的版本\n')

    await pushVaultFiles(deps(rootA, dbA, 'devA'))
    const pull = await pullVaultFiles(deps(rootB, dbB, 'devB'))

    expect(pull.conflicts).toHaveLength(1)
    const copy = pull.conflicts[0]!
    expect(copy).toMatch(/^c\.notefast-conflict-devB-[0-9]{8}-[0-9]{6}\.md$/)
    expect(read(rootB, 'c.md')).toBe('A 的版本\n')
    expect(read(rootB, copy)).toBe('B 的版本\n')
  })

  test('本地有未推送改动时，远端删除不覆盖本地（记冲突、保留文件）', async () => {
    writeFile(rootA, 'd.md', '基线\n')
    await syncAtoB()

    writeFile(rootB, 'd.md', 'B 本地改动\n')
    unlinkSync(join(rootA, 'd.md'))
    await pushVaultFiles(deps(rootA, dbA, 'devA'))

    const pull = await pullVaultFiles(deps(rootB, dbB, 'devB'))
    expect(pull.deleted).toBe(0)
    expect(pull.conflicts).toEqual(['d.md'])
    expect(read(rootB, 'd.md')).toBe('B 本地改动\n')
  })

  test('资源文件（图片）也同步', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    mkdirSync(join(rootA, 'assets'), { recursive: true })
    writeFileSync(join(rootA, 'assets', 'p.png'), png)
    await syncAtoB()
    expect(new Uint8Array(readFileSync(join(rootB, 'assets', 'p.png')))).toEqual(png)
  })

  test('远端 vault_id 与本端不一致 → 拒绝混库', async () => {
    await expect(
      ensureVaultSyncMeta(createLocalFsObjectStore(storeDir), PREFIX, crypto.randomUUID()),
    ).rejects.toThrow(/vault_id/)
  })

  test('可同步路径判定：.md 与资源白名单，其余跳过', () => {
    expect(isSyncableRelPath('a.md')).toBe(true)
    expect(isSyncableRelPath('dir/图片.PNG')).toBe(true)
    expect(isSyncableRelPath('x.pdf')).toBe(true)
    expect(isSyncableRelPath('note.txt')).toBe(false)
    expect(isSyncableRelPath('script.ts')).toBe(false)
    expect(isSyncableRelPath('noext')).toBe(false)
  })

  test('清单合并：两端各自的分片按 updated_at 取新', async () => {
    writeFile(rootA, 'm.md', 'A\n')
    await pushVaultFiles(deps(rootA, dbA, 'devA'))
    writeFile(rootB, 'm.md', 'B 新\n')
    await pushVaultFiles(deps(rootB, dbB, 'devB'))

    const merged = await readRemoteEntries(createLocalFsObjectStore(storeDir), PREFIX)
    expect(merged.size).toBe(1)
    expect(merged.get('m.md')!.device_id).toBe('devB')
  })
})
