/**
 * 备份引擎 + API 集成测试（内存 stub S3）
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  BACKUP_SECRET_MASK,
  buildManifestObjectKey,
  isBackupManifest,
  type BackupManifest,
  type BackupRestorePoint,
} from '@notefast/core'
import { initDb, closeDb, getDb } from '../db'
import { initAssetStore } from '../assets/store'
import backupRouter from '../api/backup'
import {
  applyBackupManagerConfig,
  backupStatus,
  initBackupManager,
  listBackupRestorePoints,
  runBackupNow,
  _handleAutoBackupTickErrorForTests,
  _resetBackupManagerForTests,
} from '../backup/manager'
import { createLocalSnapshot, cleanupSnapshot, hashFile, verifySnapshotFile } from '../backup/snapshot'
import { createS3Store, type S3StoreLike } from '../backup/s3Store'
import { durableReplaceFile } from '../backup/durableFs'
import { assertSchemaCompatible, CURRENT_SCHEMA_VERSION } from '@notefast/core'

let testDir: string
let app: Hono

function createMemoryStore(): S3StoreLike & {
  objects: Map<string, Buffer | string>
  failUpload?: boolean
} {
  const objects = new Map<string, Buffer | string>()
  const store: S3StoreLike & { objects: Map<string, Buffer | string>; failUpload?: boolean } = {
    objects,
    failUpload: false,
    async testConnection() {
      return { ok: true }
    },
    async uploadSnapshot({ localPath, sha256, sizeBytes, schemaVersion, appVersion }) {
      if (store.failUpload) throw new Error('upload failed (stub)')
      const id = crypto.randomUUID().slice(0, 8)
      const objectKey = `test/snapshots/2026-01-01T00-00-00-000Z-${id}.db`
      const manifestKey = buildManifestObjectKey(objectKey)
      const body = readFileSync(localPath)
      objects.set(objectKey, body)
      const manifest: BackupManifest = {
        app: 'notefast',
        kind: 'sqlite-snapshot',
        version: 1,
        createdAt: new Date().toISOString(),
        objectKey,
        sizeBytes,
        sha256,
        schemaVersion,
        appVersion,
      }
      objects.set(manifestKey, JSON.stringify(manifest))
      return { objectKey, manifestKey, manifest }
    },
    async listRestorePoints({ limit = 50 } = {}) {
      const points: BackupRestorePoint[] = []
      for (const [key, val] of objects) {
        if (!key.endsWith('.manifest.json')) continue
        const m = JSON.parse(String(val)) as BackupManifest
        if (!isBackupManifest(m)) continue
        points.push({
          objectKey: m.objectKey,
          manifestKey: key,
          createdAt: m.createdAt,
          sizeBytes: m.sizeBytes,
          sha256: m.sha256,
          schemaVersion: m.schemaVersion,
          appVersion: m.appVersion,
        })
      }
      points.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return points.slice(0, limit)
    },
    async downloadObject(key, destPath) {
      const v = objects.get(key)
      if (v === undefined) throw new Error(`missing ${key}`)
      writeFileSync(destPath, typeof v === 'string' ? v : v)
    },
    async getManifest(manifestKey) {
      const v = objects.get(manifestKey)
      if (v === undefined) throw new Error(`missing ${manifestKey}`)
      const m = JSON.parse(String(v)) as unknown
      if (!isBackupManifest(m)) throw new Error('bad manifest')
      return m
    },
    async pruneOlderThan() {
      return { deleted: 0, errors: [] }
    },
  }
  return store
}

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-backup-'))
  initDb(testDir)
  initAssetStore(testDir)
  const db = getDb()
  const nb = (db.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }).id
  const docId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
  ).run(docId, nb, docId, 'Backup Doc', now, now)
  const child = crypto.randomUUID()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'paragraph', ?, 0, 1, ?, ?)`,
  ).run(child, nb, docId, docId, 'hello backup', now, now)

  app = new Hono()
  app.use('*', cors({ origin: '*' }))
  app.route('/api/v1/backup', backupRouter)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  _resetBackupManagerForTests()
})

describe('snapshot', () => {
  test('VACUUM INTO 生成可校验快照', async () => {
    const work = join(testDir, 'snap-work')
    mkdirSync(work, { recursive: true })
    const snap = await createLocalSnapshot(work)
    expect(snap.sizeBytes).toBeGreaterThan(0)
    expect(snap.sha256).toHaveLength(64)
    expect(snap.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    verifySnapshotFile(snap.path)
    expect(await hashFile(snap.path)).toBe(snap.sha256)
    cleanupSnapshot(snap.tempDir)
  })
})

describe('backup manager', () => {
  test('runBackupNow 上传恢复点', async () => {
    const mem = createMemoryStore()
    initBackupManager(testDir, { storeFactory: () => mem })
    await applyBackupManagerConfig({
      version: 1,
      enabled: true,
      intervalMs: 0,
      retentionDays: 30,
      s3: {
        bucket: 'b',
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
        prefix: 'test',
      },
    })
    const result = await runBackupNow()
    expect(result.ok).toBe(true)
    expect(result.objectKey).toBeTruthy()
    expect(mem.objects.has(result.objectKey!)).toBe(true)
    expect(mem.objects.has(result.manifestKey!)).toBe(true)
    const points = await listBackupRestorePoints()
    expect(points.length).toBe(1)
    expect(backupStatus().lastSuccessAt).toBeTruthy()
  })

  test('store 暴露 mediaClient 时，runBackupNow 会上送 media 并计入结果', async () => {
    // media 目录放一个合法 sha256 文件
    const mediaDir = join(testDir, 'media')
    mkdirSync(mediaDir, { recursive: true })
    const sha = 'f'.repeat(64)
    writeFileSync(join(mediaDir, sha), 'IMG')

    // 内存 mock：提供 mediaClient（fake），PutObject 写入 objects，ListObjects 返回空
    const mem = createMemoryStore()
    mem.mediaClient = {
      async send(command: unknown) {
        const cmd = command as { constructor: { name: string }; input: Record<string, unknown> }
        const name = cmd.constructor.name
        if (name === 'ListObjectsV2Command') return { Contents: [], IsTruncated: false }
        if (name === 'PutObjectCommand') {
          mem.objects.set(cmd.input.Key as string, cmd.input.Body as Buffer)
          return {}
        }
        throw new Error(`unexpected ${name}`)
      },
    } as never

    initBackupManager(testDir, { storeFactory: () => mem })
    await applyBackupManagerConfig({
      version: 1,
      enabled: true,
      intervalMs: 0,
      retentionDays: 30,
      s3: { bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's', prefix: 'test' },
    })
    const result = await runBackupNow()
    expect(result.ok).toBe(true)
    expect(result.mediaUploaded).toBeDefined()
    expect(result.mediaUploaded!.uploaded).toBe(1)
    expect(mem.objects.has('test/media/' + sha)).toBe(true)
  })

  test('并发备份返回 backup_in_progress', async () => {
    const mem = createMemoryStore()
    // 慢上传
    const orig = mem.uploadSnapshot.bind(mem)
    mem.uploadSnapshot = async (opts) => {
      await Bun.sleep(80)
      return orig(opts)
    }
    initBackupManager(testDir, { storeFactory: () => mem })
    await applyBackupManagerConfig({
      version: 1,
      enabled: true,
      intervalMs: 0,
      retentionDays: 30,
      s3: {
        bucket: 'b',
        region: 'r',
        accessKeyId: 'k',
        secretAccessKey: 's',
      },
    })
    const p1 = runBackupNow()
    await Bun.sleep(10)
    let code = ''
    try {
      await runBackupNow()
    } catch (e) {
      code = (e as { code?: string }).code || ''
    }
    await p1
    expect(code).toBe('backup_in_progress')
  })

  test('上传失败不影响在线库', async () => {
    const mem = createMemoryStore()
    mem.failUpload = true
    initBackupManager(testDir, { storeFactory: () => mem })
    await applyBackupManagerConfig({
      version: 1,
      enabled: true,
      intervalMs: 0,
      retentionDays: 30,
      s3: {
        bucket: 'b',
        region: 'r',
        accessKeyId: 'k',
        secretAccessKey: 's',
      },
    })
    const before = (getDb().query("SELECT count(*) as c FROM blocks WHERE type='document'").get() as { c: number }).c
    await expect(runBackupNow()).rejects.toThrow(/upload failed/)
    const after = (getDb().query("SELECT count(*) as c FROM blocks WHERE type='document'").get() as { c: number }).c
    expect(after).toBe(before)
    expect(backupStatus().lastError).toContain('upload failed')
  })
})

describe('backup HTTP', () => {
  async function api(method: string, path: string, body?: unknown) {
    const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await app.fetch(new Request(`http://localhost/api/v1/backup${path}`, init))
    return { status: res.status, body: await res.json() }
  }

  test('PUT config 脱敏；二次保存保留密钥', async () => {
    const mem = createMemoryStore()
    initBackupManager(testDir, { storeFactory: () => mem })
    const put1 = await api('PUT', '/config', {
      enabled: true,
      intervalMs: 0,
      retentionDays: 7,
      s3: {
        bucket: 'b',
        region: 'r',
        accessKeyId: 'REAL_AK',
        secretAccessKey: 'REAL_SK',
        prefix: 'p',
      },
    })
    expect(put1.status).toBe(200)
    expect(put1.body.config.s3.accessKeyId).toBe(BACKUP_SECRET_MASK)

    const put2 = await api('PUT', '/config', {
      enabled: true,
      intervalMs: 0,
      retentionDays: 7,
      s3: {
        bucket: 'b2',
        region: 'r',
        accessKeyId: BACKUP_SECRET_MASK,
        secretAccessKey: BACKUP_SECRET_MASK,
        prefix: 'p',
      },
    })
    expect(put2.status).toBe(200)
    // 磁盘仍存真实密钥
    const disk = JSON.parse(readFileSync(join(testDir, 'backup.config.json'), 'utf-8'))
    expect(disk.s3.accessKeyId).toBe('REAL_AK')
    expect(disk.s3.bucket).toBe('b2')
  })

  test('POST /run + GET restore-points', async () => {
    const mem = createMemoryStore()
    initBackupManager(testDir, { storeFactory: () => mem })
    await api('PUT', '/config', {
      enabled: true,
      intervalMs: 0,
      retentionDays: 30,
      s3: {
        bucket: 'b',
        region: 'r',
        accessKeyId: 'k',
        secretAccessKey: 's',
      },
    })
    const run = await api('POST', '/run')
    expect(run.status).toBe(200)
    expect(run.body.result.ok).toBe(true)
    const list = await api('GET', '/restore-points')
    expect(list.status).toBe(200)
    expect(list.body.points.length).toBeGreaterThanOrEqual(1)
  })
})

describe('restore 兼容性', () => {
  test('未来 schema 被拒绝', () => {
    expect(() => assertSchemaCompatible(CURRENT_SCHEMA_VERSION + 5)).toThrow(/高于当前程序/)
  })

  test('backup→清空→从快照文件恢复内容', async () => {
    const work = join(testDir, 'restore-work')
    mkdirSync(work, { recursive: true })
    const snap = await createLocalSnapshot(work)
    // 用快照打开并核验文档仍在
    const { Database } = await import('bun:sqlite')
    const d = new Database(snap.path, { readonly: true })
    const docs = d.query("SELECT content FROM blocks WHERE type='document'").all() as Array<{ content: string }>
    expect(docs.some((x) => x.content === 'Backup Doc')).toBe(true)
    d.close()
    cleanupSnapshot(snap.tempDir)
    expect(existsSync(snap.path)).toBe(false)
  })

  test('durableReplaceFile 写入后目标可读且 staging 消失', () => {
    const dir = join(testDir, 'durable-replace')
    mkdirSync(dir, { recursive: true })
    const staging = join(dir, 'notefast.db.restoring')
    const target = join(dir, 'notefast.db')
    durableReplaceFile(staging, target, Buffer.from('sqlite-bytes'))
    expect(existsSync(staging)).toBe(false)
    expect(readFileSync(target, 'utf-8')).toBe('sqlite-bytes')
  })
})

describe('prune 全量列举', () => {
  test('超过 UI limit 的老恢复点仍会被清理', async () => {
    const objects = new Map<string, string>()
    const deleted: string[] = []

    // 1205 个恢复点：200 个超期 + 1005 个近期（相对保留 30 天）
    const recentDay = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)
    for (let i = 0; i < 1205; i++) {
      const old = i < 200
      const day = old ? '2020-01-01' : recentDay
      const id = String(i).padStart(4, '0')
      const objectKey = `p/snapshots/${day}T00-00-00-000Z-${id}.db`
      const manifestKey = buildManifestObjectKey(objectKey)
      const manifest: BackupManifest = {
        app: 'notefast',
        kind: 'sqlite-snapshot',
        version: 1,
        createdAt: `${day}T00:00:00.000Z`,
        objectKey,
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
        schemaVersion: 1,
      }
      objects.set(manifestKey, JSON.stringify(manifest))
      objects.set(objectKey, 'db')
    }

    const client = {
      async send(command: unknown) {
        const cmd = command as { constructor: { name: string }; input: Record<string, unknown> }
        const name = cmd.constructor.name
        if (name === 'ListObjectsV2Command') {
          const prefix = String(cmd.input.Prefix || '')
          const token = cmd.input.ContinuationToken as string | undefined
          const allKeys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
          const pageSize = 100
          const start = token ? parseInt(token, 10) : 0
          const slice = allKeys.slice(start, start + pageSize)
          const next = start + pageSize
          return {
            Contents: slice.map((Key) => ({ Key })),
            IsTruncated: next < allKeys.length,
            NextContinuationToken: next < allKeys.length ? String(next) : undefined,
          }
        }
        if (name === 'GetObjectCommand') {
          const key = cmd.input.Key as string
          const body = objects.get(key)
          if (body === undefined) throw new Error('missing')
          return { Body: { transformToString: async () => body, transformToByteArray: async () => Buffer.from(body) } }
        }
        if (name === 'DeleteObjectCommand') {
          const key = cmd.input.Key as string
          deleted.push(key)
          objects.delete(key)
          return {}
        }
        throw new Error(`unexpected ${name}`)
      },
    }

    const store = createS3Store(
      {
        bucket: 'b',
        region: 'r',
        accessKeyId: 'k',
        secretAccessKey: 's',
        prefix: 'p',
      },
      client as never,
    )

    // UI 只看 50 条时看不到 2020 的老点
    const ui = await store.listRestorePoints({ limit: 50 })
    expect(ui.every((p) => !p.createdAt.startsWith('2020'))).toBe(true)

    const result = await store.pruneOlderThan(30)
    expect(result.deleted).toBe(400) // 200 manifests + 200 db
    expect(deleted.some((k) => k.includes('2020-01-01'))).toBe(true)
    // 近期点仍在
    expect([...objects.keys()].some((k) => k.includes(recentDay))).toBe(true)
  })
})

describe('自动备份重叠跳过', () => {
  test('backup_in_progress 时重排 nextRunAt 且不记 lastError', async () => {
    const mem = createMemoryStore()
    initBackupManager(testDir, { storeFactory: () => mem })
    await applyBackupManagerConfig({
      version: 1,
      enabled: true,
      intervalMs: 60_000,
      retentionDays: 30,
      s3: {
        bucket: 'b',
        region: 'r',
        accessKeyId: 'k',
        secretAccessKey: 's',
      },
    })
    const before = backupStatus().nextRunAt
    expect(before).toBeTruthy()
    await Bun.sleep(5)
    _handleAutoBackupTickErrorForTests(
      Object.assign(new Error('备份任务正在进行中'), { code: 'backup_in_progress' }),
    )
    const after = backupStatus().nextRunAt
    expect(after).toBeTruthy()
    expect(Date.parse(after!)).toBeGreaterThanOrEqual(Date.parse(before!))
    expect(backupStatus().lastError).toBeUndefined()
  })
})
