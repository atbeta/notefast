import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { initDb, closeDb, getDb } from '../db'
import { insertBlock, updateBlock, softDeleteBlocks, restoreBlocks, nowTimestamp } from '../store/blocks'
import { runMigrations } from '../migrations/framework'
import { configureSqliteForExtensions } from '../sqliteVec'
import {
  publishChanges,
  consumeChanges,
  consumeSnapshot,
  compactChanges,
  detectLayout,
  migrateV1Layout,
  readManifest,
  updateManifest,
} from '../sync/protocol'
import { getChangesAnchor, listChanges } from '../store/changeFeed'
import { createS3ObjectStore } from '../storage/objectStore'
import {
  CHANGES_PER_SEGMENT,
  SYNC_S3_DIR,
} from '@notefast/core'

/**
 * 同步协议 v2（方案 A 数据面，多写端对等拓扑）：
 * - publishChanges 把本地 entity_changes 增量导出为 changes/<device_id>/ 分段 jsonl
 * - consumeChanges 按 per-device 高水位过滤，updated_at LWW 合并进目标库
 * - manifest v2 记录 devices（各端增量终点提示）+ snapshot（per-device 快照锚点）
 * - v1 布局（根级段 + version 1 manifest）由 detectLayout 识别、migrateV1Layout 迁移
 */

let testDir: string
let notebookId: string
let sourceDb: ReturnType<typeof getDb>

/** 内存 S3 mock（Put/Get/List/Delete/DeleteObjects） */
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
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec('PRAGMA foreign_keys=ON')
  return db
}

/** 通用文档块插入（任意库句柄；多写端测试的 B/C/D 端用） */
function insertDocInto(db: Database, id: string, content: string): void {
  insertBlock(db, {
    id,
    notebook_id: notebookId,
    parent_id: null,
    root_id: id,
    type: 'document',
    content,
    sort: 0,
    level: 0,
    now: nowTimestamp(),
  })
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

    // 发布（从 0），带设备标识；段写入本端 namespace
    const lastSeq = await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')
    expect(lastSeq).toBe(getChangesAnchor(sourceDb))

    // 段按 device 分桶，且每条变更带发布端 device_id
    const changeKey = [...objects.keys()].find((k) => k.includes(`${SYNC_S3_DIR}/changes/dev-test/`))
    expect(changeKey).toBeTruthy()
    const firstLine = String(objects.get(changeKey!)).split('\n')[0]!
    expect(JSON.parse(firstLine).device_id).toBe('dev-test')

    // manifest v2：devices 记录本端增量终点
    await updateManifest(store, CFG.prefix, 'dev-test', lastSeq)
    const manifest = await readManifest(store, CFG.prefix)
    expect(manifest).not.toBeNull()
    expect(manifest!.version).toBe(2)
    expect(manifest!.devices['dev-test']).toBe(lastSeq)

    // 目标端：空库增量合并
    const target = makeTargetDb()
    const res = await consumeChanges(target, store, CFG.prefix, {}, 'consumer')
    expect(res.watermarks['dev-test']).toBe(lastSeq)

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

    await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')
    const target = makeTargetDb()
    const res = await consumeChanges(target, store, CFG.prefix, {}, 'consumer')
    expect(res.applied).toBeGreaterThan(0)
    // 目标库中该块 is_deleted = 1
    const row = target.query('SELECT is_deleted FROM blocks WHERE id = ?').get(a) as { is_deleted: number } | undefined
    expect(row?.is_deleted).toBe(1)
    target.close()
  })

  test('ai_exclude 文档照常同步（不发假 tombstone；回归：曾误把隐藏当删除）', async () => {
    const { client, objects } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const docId = crypto.randomUUID()
    const childId = crypto.randomUUID()
    insertBlockRow(docId, '密钥汇总')
    insertBlock(sourceDb, {
      id: childId,
      notebook_id: notebookId,
      parent_id: docId,
      root_id: docId,
      type: 'paragraph',
      content: 'secret-token',
      sort: 0,
      level: 1,
      now: nowTimestamp(),
    })
    // 标记对 AI 隐藏（只隔离检索/MCP，不该影响同步）
    updateBlock(sourceDb, docId, { ai_exclude: 1 })

    await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')

    // 发布行里：ai_exclude 文档根必须带 block，且 is_erased=0
    const changeKeys = [...objects.keys()].filter((k) => k.includes(`${SYNC_S3_DIR}/changes/`))
    const lines = changeKeys.flatMap((k) => String(objects.get(k)).split('\n').filter(Boolean))
    const docLines = lines
      .map((l) => JSON.parse(l) as { entity_id: string; is_erased: number; block?: { ai_exclude: number; content: string } })
      .filter((c) => c.entity_id === docId)
    expect(docLines.length).toBeGreaterThan(0)
    const latestDoc = docLines[docLines.length - 1]!
    expect(latestDoc.is_erased).toBe(0)
    expect(latestDoc.block?.ai_exclude).toBe(1)
    expect(latestDoc.block?.content).toBe('密钥汇总')

    const target = makeTargetDb()
    await consumeChanges(target, store, CFG.prefix, {}, 'consumer')
    const row = target
      .query('SELECT content, ai_exclude, is_deleted FROM blocks WHERE id = ?')
      .get(docId) as { content: string; ai_exclude: number; is_deleted: number } | undefined
    expect(row).toBeTruthy()
    expect(row!.is_deleted).toBe(0)
    expect(row!.ai_exclude).toBe(1)
    expect(row!.content).toBe('密钥汇总')
    const child = target
      .query('SELECT content, is_deleted FROM blocks WHERE id = ?')
      .get(childId) as { content: string; is_deleted: number } | undefined
    expect(child?.is_deleted).toBe(0)
    expect(child?.content).toBe('secret-token')
    target.close()
  })

  test('LWW：目标已有更新的块不被旧值覆盖', async () => {
    const { client } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const a = crypto.randomUUID()
    insertBlockRow(a, '源端旧值')

    await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')

    // 目标端：先手动建一个 updated_at 更新的块
    const target = makeTargetDb()
    const newer = new Date(Date.now() + 60_000).toISOString().replace('T', ' ').replace('Z', '')
    target.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, tags, status, ai_exclude, sort, level, is_deleted, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', '目标端新值', '{}', '[]', 'note', 0, 0, 0, 0, ?, ?)`,
    ).run(a, notebookId, a, newer, newer)

    const res = await consumeChanges(target, store, CFG.prefix, {}, 'consumer')
    // 旧值被跳过
    expect(res.skipped).toBeGreaterThan(0)
    const row = target.query('SELECT content FROM blocks WHERE id = ?').get(a) as { content: string }
    expect(row.content).toBe('目标端新值') // 未被覆盖
    target.close()
  })

  test('分段：超过 CHANGES_PER_SEGMENT 产生多个 changes 对象', async () => {
    const { client, objects } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    // 制造 CHANGES_PER_SEGMENT + 10 条变更（同一事务，避免 500+ 次 auto-commit）
    sourceDb.transaction(() => {
      for (let i = 0; i < CHANGES_PER_SEGMENT + 10; i++) {
        insertBlockRow(crypto.randomUUID(), `块${i}`)
      }
    })()
    await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')
    const changesKeys = [...objects.keys()].filter((k) => k.includes(`${SYNC_S3_DIR}/changes/`))
    expect(changesKeys.length).toBeGreaterThanOrEqual(2)

    // 消费端完整合并
    const target = makeTargetDb()
    const res = await consumeChanges(target, store, CFG.prefix, {}, 'consumer')
    expect(res.applied).toBeGreaterThanOrEqual(CHANGES_PER_SEGMENT)
    const count = target.query('SELECT COUNT(*) AS c FROM blocks WHERE is_deleted = 0').get() as { c: number }
    expect(count.c).toBeGreaterThanOrEqual(CHANGES_PER_SEGMENT)
    target.close()
  })

  test('compactChanges 生成快照 + 清理本端 namespace 旧增量段', async () => {
    const { client, objects } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const workDir = join(testDir, `compact-work-${crypto.randomUUID()}`)
    // 造几条变更 → 发布成增量段
    for (let i = 0; i < 5; i++) {
      insertBlockRow(crypto.randomUUID(), `compact块${i}`)
    }
    const lastSeq = await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')
    expect([...objects.keys()].some((k) => k.includes(`${SYNC_S3_DIR}/changes/`))).toBe(true)

    // compaction：快照 + 清空本端 changes 段
    const { anchor } = await compactChanges(sourceDb, store, CFG.prefix, workDir, 'dev-test', {})
    expect(anchor).toBe(lastSeq)
    // 快照对象存在（snapshot.db + snapshot.meta.json）
    expect([...objects.keys()].some((k) => k.endsWith('snapshot.db'))).toBe(true)
    expect([...objects.keys()].some((k) => k.endsWith('snapshot.meta.json'))).toBe(true)
    // 旧增量段被清空
    expect([...objects.keys()].some((k) => k.includes(`${SYNC_S3_DIR}/changes/`))).toBe(false)
  })

  test('compactChanges 以快照锚点裁剪本地 entity_changes，之后的新变更照常发布', async () => {
    const { client, objects } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const workDir = join(testDir, `compact-prune-${crypto.randomUUID()}`)

    insertBlockRow(crypto.randomUUID(), '待裁剪块')
    const lastSeq = await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')
    expect(listChanges(sourceDb).length).toBeGreaterThan(0)

    // compaction：快照覆盖到锚点 → 本地 <= 锚点的历史行被裁剪
    const { anchor } = await compactChanges(sourceDb, store, CFG.prefix, workDir, 'dev-test', {})
    expect(anchor).toBe(lastSeq)
    expect(listChanges(sourceDb)).toEqual([])
    expect(getChangesAnchor(sourceDb)).toBe(0)

    // 裁剪不重置 seq：新变更从锚点之后继续，publish 从锚点续拉恰好导出它
    const d = crypto.randomUUID()
    insertBlockRow(d, '裁剪后的新块')
    expect(getChangesAnchor(sourceDb)).toBe(anchor + 1)
    const nextPublished = await publishChanges(sourceDb, store, CFG.prefix, anchor, 'dev-test')
    expect(nextPublished).toBe(anchor + 1)
    const segKey = [...objects.keys()].find((k) => k.includes(`${SYNC_S3_DIR}/changes/`))!
    const lines = String(objects.get(segKey)).split('\n').filter((l) => l.trim())
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]!).entity_id).toBe(d)
  })

  test('consumeSnapshot 拉取快照写入目标文件，返回 per-device 锚点', async () => {
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
    objects.set('psync/snapshot.meta.json', JSON.stringify({
      version: 2,
      created_by: 'dev-snap',
      created_at: now,
      anchors: { 'dev-snap': 42 },
    }))

    // consume 到独立目标文件
    const targetPath = join(testDir, `snapshot-target-${crypto.randomUUID()}.db`)
    const anchors = await consumeSnapshot(store, CFG.prefix, targetPath)
    expect(anchors).toEqual({ 'dev-snap': 42 })
    // 目标文件是可校验的 SQLite 快照
    expect(existsSync(targetPath)).toBe(true)
    const db = new Database(targetPath, { readonly: true })
    const count = db.query('SELECT COUNT(*) AS c FROM blocks').get() as { c: number }
    expect(count.c).toBeGreaterThan(0)
    db.close()
    rmSync(targetPath, { force: true })
  })

  test('回波抑制：consume 不写本端 entity_changes，本地编辑照常进 feed', async () => {
    const { client } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const a = crypto.randomUUID()
    insertBlockRow(a, '回波源文档')
    await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')

    const target = makeTargetDb()
    const res = await consumeChanges(target, store, CFG.prefix, {}, 'consumer')
    expect(res.applied).toBeGreaterThan(0)
    // 消费不产生回波：目标端 change feed 为空（trigger WHEN 子句被 guard 抑制）
    expect(listChanges(target)).toEqual([])
    expect(getChangesAnchor(target)).toBe(0)
    // guard 行不残留（事务内清理）
    expect(target.query('SELECT COUNT(*) AS c FROM sync_consume_guard').get()).toEqual({ c: 0 })

    // 本地正常编辑仍进 feed——trigger 只挡 consume 临界区
    insertBlock(target, {
      id: crypto.randomUUID(),
      notebook_id: notebookId,
      parent_id: a,
      root_id: a,
      type: 'paragraph',
      content: '本地后续编辑',
      sort: 0,
      level: 1,
      now: nowTimestamp(),
    })
    const local = listChanges(target)
    // 两条：子块 INSERT + 文档根冒泡 UPDATE（子块变更顶根块 updated_at，
    // 多端「最近更新」与 editor 整篇保存语义一致）；均非删除事件
    expect(local.length).toBe(2)
    expect(local.every((c) => c.is_erased === 0)).toBe(true)
    // 其中一条是文档根 a 的冒泡事件
    expect(local.some((c) => c.entity_id === a)).toBe(true)
    target.close()
  })

  test('删除→恢复 离线批量消费：tombstone 用删除事件时间裁决，恢复不被吞', async () => {
    const { client, objects } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const a = crypto.randomUUID()
    insertBlockRow(a, '先删后恢复')
    await new Promise((r) => setTimeout(r, 20))
    softDeleteBlocks(sourceDb, [a])
    await new Promise((r) => setTimeout(r, 20))
    restoreBlocks(sourceDb, [a])

    // 一次性发布整段历史（模拟本端离线期间的远端变更序列）
    await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')
    // tombstone 行必须附带删除事件时间（毫秒精度），非消费时刻
    const changeKeys = [...objects.keys()].filter((k) => k.includes(`${SYNC_S3_DIR}/changes/`))
    const lines = changeKeys.flatMap((k) => String(objects.get(k)).split('\n').filter(Boolean))
    const erased = lines
      .map((l) => JSON.parse(l) as { entity_id: string; is_erased: number; deleted_at?: string })
      .filter((c) => c.entity_id === a && c.is_erased === 1)
    expect(erased.length).toBe(1)
    expect(erased[0]!.deleted_at).toBeTruthy()

    // 本端离线后批量消费：最终为活文档（旧实现 tombstone 用消费时刻 > 恢复时间，
    // 随后的恢复 upsert 被 LWW 跳过，本端永久停在已删除）
    const target = makeTargetDb()
    await consumeChanges(target, store, CFG.prefix, {}, 'consumer')
    const row = target
      .query('SELECT is_deleted, content FROM blocks WHERE id = ?')
      .get(a) as { is_deleted: number; content: string } | undefined
    expect(row?.is_deleted).toBe(0)
    expect(row?.content).toBe('先删后恢复')
    target.close()
  })

  test('软删块上的非 erase 变更不复活块（is_deleted 按远端状态写入）', async () => {
    const { client } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const a = crypto.randomUUID()
    insertBlockRow(a, '删除后仍有更新')
    await new Promise((r) => setTimeout(r, 20))
    softDeleteBlocks(sourceDb, [a])
    await new Promise((r) => setTimeout(r, 20))
    // 远端对已软删块的进一步内容更新（trigger：is_deleted 1→1，is_erased=0，
    // 附带的块状态 is_deleted=1）——旧消费端硬编码 is_deleted=0 会把块复活
    sourceDb.query(`UPDATE blocks SET content = ?, updated_at = ? WHERE id = ?`).run(
      '删除后的修改',
      nowTimestamp(),
      a,
    )

    await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')
    const target = makeTargetDb()
    await consumeChanges(target, store, CFG.prefix, {}, 'consumer')
    const row = target
      .query('SELECT is_deleted, content FROM blocks WHERE id = ?')
      .get(a) as { is_deleted: number; content: string } | undefined
    expect(row?.is_deleted).toBe(1)
    expect(row?.content).toBe('删除后的修改')
    target.close()
  })

  test('consume tombstone 级联：refs / mentions / 向量被清', async () => {
    const { client } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const a = crypto.randomUUID()
    insertBlockRow(a, '待级联删除')
    const seq = await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-test')

    // 目标端：先消费出活块，再挂上引用 / 实体提及 / 向量（模拟本端已有索引与图谱数据）
    const target = makeTargetDb()
    await consumeChanges(target, store, CFG.prefix, {}, 'consumer')
    const b = crypto.randomUUID()
    target.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, tags, status, ai_exclude, sort, level, is_deleted, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', '引用方', '{}', '[]', 'note', 0, 0, 0, 0, ?, ?)`,
    ).run(b, notebookId, b, nowTimestamp(), nowTimestamp())
    target.query(`INSERT INTO block_refs (source_id, target_id, ref_type) VALUES (?, ?, 'ai_auto')`).run(b, a)
    target.query(`INSERT INTO entities (id, name, display, kind, mention_count) VALUES (?, ?, ?, 'concept', 1)`).run(
      'ent-1', '级联实体', '级联实体',
    )
    target.query(`INSERT INTO entity_mentions (entity_id, block_id, surface) VALUES ('ent-1', ?, '级联实体')`).run(a)
    target.query(`INSERT INTO block_vectors (block_id, embedding, dim) VALUES (?, ?, 2)`).run(a, '[0.1,0.2]')

    // 源端删除 → 发布 tombstone → 目标端按 per-device 水位续消费
    await new Promise((r) => setTimeout(r, 20))
    softDeleteBlocks(sourceDb, [a])
    await publishChanges(sourceDb, store, CFG.prefix, seq, 'dev-test')
    const res = await consumeChanges(target, store, CFG.prefix, { 'dev-test': seq }, 'consumer')
    expect(res.applied).toBeGreaterThan(0)

    const row = target.query('SELECT is_deleted FROM blocks WHERE id = ?').get(a) as { is_deleted: number }
    expect(row.is_deleted).toBe(1)
    expect(target.query('SELECT COUNT(*) AS c FROM block_refs WHERE source_id = ? OR target_id = ?').get(a, a))
      .toEqual({ c: 0 })
    expect(target.query('SELECT COUNT(*) AS c FROM entity_mentions WHERE block_id = ?').get(a))
      .toEqual({ c: 0 })
    expect(target.query('SELECT COUNT(*) AS c FROM block_vectors WHERE block_id = ?').get(a))
      .toEqual({ c: 0 })
    // 提及归零后实体被清理（deleteMentionsTouchingBlocks 语义）
    expect(target.query('SELECT COUNT(*) AS c FROM entities WHERE id = ?').get('ent-1'))
      .toEqual({ c: 0 })
    target.close()
  })
})

describe('sync protocol v2（多写端对等拓扑）', () => {
  test('双写端：B 的本地 seq 远小于 A，A 消费不跳过 B 的段，变更互达', async () => {
    const { client, objects } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)

    // A（sourceDb，seq 已被前序测试推高）发布
    const docA = crypto.randomUUID()
    insertBlockRow(docA, 'A端文档')
    const anchorA = await publishChanges(sourceDb, store, CFG.prefix, 0, 'dev-A')

    // B：独立库（本地 seq 从 1 开始，远小于 A），先消费 A
    const dbB = makeTargetDb()
    const r1 = await consumeChanges(dbB, store, CFG.prefix, {}, 'dev-B')
    expect(r1.watermarks['dev-A']).toBe(anchorA)
    expect((dbB.query('SELECT content FROM blocks WHERE id = ?').get(docA) as { content: string }).content)
      .toBe('A端文档')

    // B 本地写入并发布：seq 远小于 A 的锚点（v1 会被 A 侧 consumedSeq 整段跳过）
    const docB = crypto.randomUUID()
    insertDocInto(dbB, docB, 'B端文档')
    const anchorB = getChangesAnchor(dbB)
    expect(anchorB).toBeLessThan(anchorA)
    await publishChanges(dbB, store, CFG.prefix, 0, 'dev-B')

    // 段按设备分桶
    expect([...objects.keys()].some((k) => k.includes('changes/dev-A/'))).toBe(true)
    expect([...objects.keys()].some((k) => k.includes('changes/dev-B/'))).toBe(true)

    // A 消费：dev-B 水位从 0 起，低 seq 段正常消费（v1 回归点）
    const r2 = await consumeChanges(sourceDb, store, CFG.prefix, {}, 'dev-A')
    expect(r2.watermarks['dev-B']).toBe(anchorB)
    const row = sourceDb.query('SELECT content FROM blocks WHERE id = ?').get(docB) as { content: string } | undefined
    expect(row?.content).toBe('B端文档')

    // 再消费一轮：B 的段按水位跳过，不重复应用
    const r3 = await consumeChanges(sourceDb, store, CFG.prefix, r2.watermarks, 'dev-A')
    expect(r3.applied).toBe(0)
    expect(r3.watermarks['dev-B']).toBe(anchorB)
    dbB.close()
  })

  test('双写端：相同 seq 区间的段按 device 分桶，互不覆盖', async () => {
    const { client, objects } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const dbC = makeTargetDb()
    const dbD = makeTargetDb()
    const docC = crypto.randomUUID()
    const docD = crypto.randomUUID()
    insertDocInto(dbC, docC, 'C端文档')
    insertDocInto(dbD, docD, 'D端文档')

    // 两库本地 seq 区间完全相同（都从 1 开始），v1 下同 key 互相覆盖
    await publishChanges(dbC, store, CFG.prefix, 0, 'dev-C')
    await publishChanges(dbD, store, CFG.prefix, 0, 'dev-D')

    const keyC = [...objects.keys()].find((k) => k.includes('changes/dev-C/'))
    const keyD = [...objects.keys()].find((k) => k.includes('changes/dev-D/'))
    expect(keyC).toBeTruthy()
    expect(keyD).toBeTruthy()
    // 文件名部分（seq 区间）相同，但 namespace 不同 → 两个对象都完整存在
    expect(keyC!.split('/').pop()).toBe(keyD!.split('/').pop())
    expect(String(objects.get(keyC!))).toContain(docC)
    expect(String(objects.get(keyD!))).toContain(docD)
    dbC.close()
    dbD.close()
  })

  test('compaction 只裁本端 namespace，其他设备的段保留', async () => {
    const { client, objects } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const workDir = join(testDir, `compact-ns-${crypto.randomUUID()}`)
    const dbE = makeTargetDb()
    const dbF = makeTargetDb()
    insertDocInto(dbE, crypto.randomUUID(), 'E端文档')
    const docF = crypto.randomUUID()
    insertDocInto(dbF, docF, 'F端文档')
    const anchorE = await publishChanges(dbE, store, CFG.prefix, 0, 'dev-E')
    const anchorF = await publishChanges(dbF, store, CFG.prefix, 0, 'dev-F')

    // E compaction：视图里已消费 F 到 anchorF
    const { anchor, anchors } = await compactChanges(dbE, store, CFG.prefix, workDir, 'dev-E', { 'dev-F': anchorF })
    expect(anchor).toBe(anchorE)
    expect(anchors['dev-E']).toBe(anchorE)
    expect(anchors['dev-F']).toBe(anchorF)

    // 本端段被清理，F 的段原样保留
    expect([...objects.keys()].some((k) => k.includes('changes/dev-E/'))).toBe(false)
    expect([...objects.keys()].some((k) => k.includes('changes/dev-F/'))).toBe(true)

    // 快照元数据锚点 = 本端视图
    const meta = JSON.parse(String(objects.get('psync/snapshot.meta.json'))) as { anchors: Record<string, number> }
    expect(meta.anchors['dev-E']).toBe(anchorE)
    expect(meta.anchors['dev-F']).toBe(anchorF)

    // 本地 entity_changes 裁到本端锚点
    expect(listChanges(dbE)).toEqual([])

    // F 的段仍可被新端消费（含 F 内容的快照覆盖不到的新端增量路径）
    const dbNew = makeTargetDb()
    await consumeChanges(dbNew, store, CFG.prefix, {}, 'dev-new')
    expect((dbNew.query('SELECT content FROM blocks WHERE id = ?').get(docF) as { content: string }).content)
      .toBe('F端文档')
    dbE.close()
    dbF.close()
    dbNew.close()
  })

  test('v1 布局：detectLayout 识别 → migrateV1Layout 合并旧段/旧快照并清理', async () => {
    const { client, objects } = makeMockS3()
    const store = createS3ObjectStore(S3_STORE_CFG, client)
    const now = nowTimestamp()

    // 手工构造 v1 布局：根级段（行内带 device_id）+ v1 manifest + snapshot.seq + v1 快照
    const legacyDoc = crypto.randomUUID()
    const legacyChild = crypto.randomUUID()
    const mkLine = (seq: number, id: string, parent: string | null, content: string) =>
      JSON.stringify({
        seq,
        entity: 'block',
        entity_id: id,
        is_erased: 0,
        actor: 'old',
        changed_at: now,
        device_id: 'old-dev',
        block: {
          id, notebook_id: notebookId, parent_id: parent, root_id: parent ?? id,
          type: parent ? 'paragraph' : 'document', content,
          properties: '{}', tags: '[]', status: 'note', ai_exclude: 0,
          sort: 0, level: parent ? 1 : 0, created_at: now, updated_at: now,
        },
      })
    objects.set('psync/changes/0000000001-0000000007.jsonl', `${mkLine(3, legacyDoc, null, 'v1旧端文档')}\n${mkLine(7, legacyChild, legacyDoc, 'v1旧端段落')}`)
    objects.set('psync/manifest.json', JSON.stringify({
      app: 'notefast', kind: 'sync', version: 1, last_seq: 7, snapshot_seq: 5, updated_at: now,
    }))
    objects.set('psync/snapshot.seq', '5')
    // v1 快照（旧端 compaction 产物，只存在于快照里的内容也要并过来）
    const snapSrc = makeTargetDb()
    snapSrc.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, tags, status, ai_exclude, sort, level, is_deleted, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', 'v1快照独有文档', '{}', '[]', 'note', 0, 0, 0, 0, ?, ?)`,
    ).run('v1-snap-doc', notebookId, 'v1-snap-doc', now, now)
    const snapPath = join(testDir, `v1-snap-${crypto.randomUUID()}.db`)
    snapSrc.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`)
    snapSrc.close()
    objects.set('psync/snapshot.db', new Uint8Array(await Bun.file(snapPath).arrayBuffer()))

    expect(await detectLayout(store, CFG.prefix)).toBe('v1')

    const target = makeTargetDb()
    const res = await migrateV1Layout(target, store, CFG.prefix, join(testDir, `migrate-${crypto.randomUUID()}`))
    // 段内 2 行 + 快照独有 1 行（快照里也含 v1-snap-doc 之外的系统行——只校验关键内容）
    expect(res.applied).toBeGreaterThanOrEqual(3)
    // 水位按行内 device_id 归因
    expect(res.watermarks['old-dev']).toBe(7)
    // 段内容与快照独有内容都合并进本地
    expect((target.query('SELECT content FROM blocks WHERE id = ?').get(legacyDoc) as { content: string }).content)
      .toBe('v1旧端文档')
    expect((target.query('SELECT content FROM blocks WHERE id = ?').get('v1-snap-doc') as { content: string }).content)
      .toBe('v1快照独有文档')
    // 迁移不写本端 change feed（guard 抑制回波）
    expect(listChanges(target)).toEqual([])

    // v1 对象全部清理，布局回到 empty（调用方随后重建 v2 快照/manifest）
    expect([...objects.keys()].some((k) => /changes\/\d{10}-\d{10}\.jsonl$/.test(k))).toBe(false)
    expect(objects.has('psync/manifest.json')).toBe(false)
    expect(objects.has('psync/snapshot.seq')).toBe(false)
    expect(objects.has('psync/snapshot.db')).toBe(false)
    expect(await detectLayout(store, CFG.prefix)).toBe('empty')
    target.close()
  })
})
