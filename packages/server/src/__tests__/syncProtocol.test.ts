import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { initDb, closeDb, getDb } from '../db'
import { insertBlock, updateBlock, softDeleteBlocks, nowTimestamp } from '../store/blocks'
import { runMigrations } from '../migrations/framework'
import { configureSqliteForExtensions } from '../sqliteVec'
import {
  publishChanges,
  consumeChanges,
  consumeSnapshot,
  compactChanges,
  readManifest,
  updateManifest,
} from '../sync/protocol'
import { getChangesAnchor } from '../store/changeFeed'
import { createS3ObjectStore } from '../storage/objectStore'
import {
  CHANGES_PER_SEGMENT,
  SYNC_S3_DIR,
} from '@notefast/core'

/**
 * 同步协议（方案 A 数据面）：
 * - publishChanges 把本地 entity_changes 增量导出为 changes/ 分段 jsonl（含块状态）
 * - consumeChanges 按 updated_at LWW 合并进目标库（insert/update/tombstone）
 * - manifest 记录 last_seq
 */

let testDir: string
let notebookId: string
let sourceDb: ReturnType<typeof getDb>

/** 内存 S3 mock（Put/Get/List） */
function makeMockS3() {
  const objects = new Map<string, string | Uint8Array>()
  const client = {
    async send(command: unknown) {
      const cmd = command as { constructor: { name: string }; input: Record<string, unknown> }
      const name = cmd.constructor.name
      if (name === 'PutObjectCommand') {
        objects.set(cmd.input.Key as string, Buffer.from(cmd.input.Body as Buffer).toString('utf8'))
        return {}
      }
      if (name === 'GetObjectCommand') {
        const key = cmd.input.Key as string
        const body = objects.get(key)
        if (body === undefined) {
          const e = new Error(`missing ${key}`) as Error & { name: string }
          e.name = 'NoSuchKey'
          throw e
        }
        return { Body: { transformToByteArray: async () => Buffer.from(body) } }
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = String(cmd.input.Prefix || '')
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
        return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false }
      }
      if (name === 'DeleteObjectCommand') {
        objects.delete(cmd.input.Key as string)
        return {}
      }
      throw new Error(`unexpected ${name}`)
    },
  } as never
  return { client, objects }
}

const CFG = { bucket: 'b', prefix: 'p' }
const S3_STORE_CFG = { bucket: 'b', region: 'r', accessKeyId: 'k', secretAccessKey: 's' }

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-sync-protocol-'))
  const r = initDb(testDir)
  notebookId = r.notebookId
  sourceDb = getDb()
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

function makeTargetDb(): Database {
  configureSqliteForExtensions()
  const db = new Database(join(testDir, `target-${crypto.randomUUID()}.db`))
  runMigrations(db)
  db.exec('PRAGMA foreign_keys=ON')
  return db
}

function insertBlockRow(id: string, content: string, parentId: string | null = null): void {
  insertBlock(sourceDb, {
    id,
    notebook_id: notebookId,
    parent_id: parentId,
    root_id: id,
    type: parentId ? 'paragraph' : 'document',
    content,
    sort: 0,
    level: parentId ? 1 : 0,
    now: nowTimestamp(),
  })
}

describe('sync protocol (publish → consume)', () => {
  test('发布增量 → 消费端 LWW upsert，块内容一致', async () => {
    const { client, objects } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)

    // 源端：建 2 个块 + 改 1 个
    const a = crypto.randomUUID()
    const b = crypto.randomUUID()
    insertBlockRow(a, '文档A')
    insertBlockRow(b, '段落B', a)
    updateBlock(sourceDb, b, { content: '段落B-改' })

    // 发布（从 0），带设备标识
    const lastSeq = await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')
    expect(lastSeq).toBe(getChangesAnchor(sourceDb))

    // 每条变更带发布端 device_id
    const changeKey = [...objects.keys()].find((k) => k.includes(`${SYNC_S3_DIR}/changes/`))
    expect(changeKey).toBeTruthy()
    const firstLine = String(objects.get(changeKey!)).split('\n')[0]!
    expect(JSON.parse(firstLine).device_id).toBe('dev-test')

    // manifest
    await updateManifest(store, CFG.prefix, lastSeq, 0)
    const manifest = await readManifest(store, CFG.prefix)
    expect(manifest).not.toBeNull()
    expect(manifest!.last_seq).toBe(lastSeq)

    // 目标端：空库增量合并
    const target = makeTargetDb()
    const res = await consumeChanges(target, store, CFG.prefix, 0, lastSeq)
    expect(res.nextSeq).toBe(lastSeq)

    // 校验目标库内容
    const rows = target.query('SELECT id, content FROM blocks ORDER BY content').all() as Array<{ id: string; content: string }>
    const contents = rows.map((r) => r.content)
    expect(contents).toContain('文档A')
    expect(contents).toContain('段落B-改')
    target.close()
  })

  test('tombstone：源端软删 → 目标端同步软删', async () => {
    const { client } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const a = crypto.randomUUID()
    insertBlockRow(a, '待删除')
    softDeleteBlocks(sourceDb, [a])

    const lastSeq = await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')
    const target = makeTargetDb()
    const res = await consumeChanges(target, store, CFG.prefix, 0, lastSeq)
    expect(res.applied).toBeGreaterThan(0)
    // 目标库中该块 is_deleted = 1
    const row = target.query('SELECT is_deleted FROM blocks WHERE id = ?').get(a) as { is_deleted: number } | undefined
    expect(row?.is_deleted).toBe(1)
    target.close()
  })

  test('LWW：目标已有更新的块不被旧值覆盖', async () => {
    const { client } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const a = crypto.randomUUID()
    insertBlockRow(a, '源端旧值')

    const lastSeq = await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')

    // 目标端：先手动建一个 updated_at 更新的块
    const target = makeTargetDb()
    const newer = new Date(Date.now() + 60_000).toISOString().replace('T', ' ').replace('Z', '')
    target.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, tags, status, ai_exclude, sort, level, is_deleted, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', '目标端新值', '{}', '[]', 'note', 0, 0, 0, 0, ?, ?)`,
    ).run(a, notebookId, a, newer, newer)

    const res = await consumeChanges(target, store, CFG.prefix, 0, lastSeq)
    // 旧值被跳过
    expect(res.skipped).toBeGreaterThan(0)
    const row = target.query('SELECT content FROM blocks WHERE id = ?').get(a) as { content: string }
    expect(row.content).toBe('目标端新值') // 未被覆盖
    target.close()
  })

  test('分段：超过 CHANGES_PER_SEGMENT 产生多个 changes 对象', async () => {
    const { client, objects } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    // 制造 CHANGES_PER_SEGMENT + 10 条变更
    for (let i = 0; i < CHANGES_PER_SEGMENT + 10; i++) {
      insertBlockRow(crypto.randomUUID(), `块${i}`)
    }
    const lastSeq = await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')
    const changesKeys = [...objects.keys()].filter((k) => k.includes(`${SYNC_S3_DIR}/changes/`))
    expect(changesKeys.length).toBeGreaterThanOrEqual(2)

    // 消费端完整合并
    const target = makeTargetDb()
    const res = await consumeChanges(target, store, CFG.prefix, 0, lastSeq)
    expect(res.applied).toBeGreaterThanOrEqual(CHANGES_PER_SEGMENT)
    const count = target.query('SELECT COUNT(*) AS c FROM blocks WHERE is_deleted = 0').get() as { c: number }
    expect(count.c).toBeGreaterThanOrEqual(CHANGES_PER_SEGMENT)
    target.close()
  })

  test('compactChanges 生成快照 + 清理旧增量段', async () => {
    const { client, objects } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const workDir = join(testDir, `compact-work-${crypto.randomUUID()}`)
    // 造几条变更 → 发布成增量段
    for (let i = 0; i < 5; i++) {
      insertBlockRow(crypto.randomUUID(), `compact块${i}`)
    }
    const lastSeq = await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')
    expect([...objects.keys()].some((k) => k.includes(`${SYNC_S3_DIR}/changes/`))).toBe(true)

    // compaction：快照 + 清空 changes 段
    const anchor = await compactChanges(sourceDb, store, CFG.prefix, workDir)
    expect(anchor).toBe(lastSeq)
    // 快照对象存在
    expect([...objects.keys()].some((k) => k.endsWith('snapshot.db'))).toBe(true)
    // 旧增量段被清空
    expect([...objects.keys()].some((k) => k.includes(`${SYNC_S3_DIR}/changes/`))).toBe(false)
  })

  test('consumeSnapshot 拉取快照写入目标文件（可校验）', async () => {
    const { client, objects } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    // 用与 makeTargetDb 相同的方式建源库，插入一行，VACUUM 成快照字节
    const fresh = makeTargetDb()
    const now = nowTimestamp()
    fresh.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, tags, status, ai_exclude, sort, level, is_deleted, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', '快照源文档', '{}', '[]', 'note', 0, 0, 0, 0, ?, ?)`,
    ).run('freshdoc', notebookId, 'freshdoc', now, now)

    const snapPath = join(testDir, `snap-${crypto.randomUUID()}.db`)
    fresh.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`)
    fresh.close()

    const snapBytes = new Uint8Array(await Bun.file(snapPath).arrayBuffer())
    objects.set('psync/snapshot.db', snapBytes)
    objects.set('psync/snapshot.seq', '1')

    // consume 到独立目标文件
    const targetPath = join(testDir, `snapshot-target-${crypto.randomUUID()}.db`)
    const seq = await consumeSnapshot(store, CFG.prefix, targetPath)
    expect(seq).toBe(1)
    // 目标文件是可校验的 SQLite 快照
    expect(existsSync(targetPath)).toBe(true)
    const db = new Database(targetPath, { readonly: true })
    const count = db.query('SELECT COUNT(*) AS c FROM blocks').get() as { c: number }
    expect(count.c).toBeGreaterThan(0)
    db.close()
    rmSync(targetPath, { force: true })
  })
})
