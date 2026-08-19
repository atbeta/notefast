import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { insertBlock, nowTimestamp } from '../store/blocks'
import {
  initProtocolManager,
  syncNow,
  syncPull,
  scheduleSyncNow,
  applyProtocolManagerConfig,
  protocolStatus,
  getDeviceId,
  listSyncDevices,
  removeSyncDevice,
  _resetProtocolManagerForTests,
  _setProtocolStoreForTests,
  _setProtocolStateForTests,
} from '../sync/protocolManager'
import { createS3ObjectStore } from '../storage/objectStore'
import { initStorageLocations, createStorageLocation, _resetStorageLocationsForTests } from '../storage/locations'
import { SYNC_S3_DIR } from '@notefast/core'

const S3_CFG = { bucket: 'b', region: 'r', accessKeyId: 'k', secretAccessKey: 's' }
let locationId = ''

/**
 * 同步协议 Manager 编排（v2：多写端对等拓扑）：
 * - initProtocolManager 使用独立的多端同步配置（与备份解耦）
 * - syncNow = 布局检测（v1 自动迁移）→ publish（本端 namespace）→ 持久化 state
 * - 消费游标为 per-device 高水位；本端 namespace 不消费
 * - state 持久化到 data/sync-state.json；配置持久化到 data/sync-protocol.config.json
 */

let testDir: string
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-syncmgr-'))
  const r = initDb(testDir)
  notebookId = r.notebookId
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  _resetProtocolManagerForTests()
  // 清理上次测试落盘的 state 与配置，保证 init 走干净初始状态
  rmSync(join(testDir, 'sync-state.json'), { force: true })
  rmSync(join(testDir, 'sync-protocol.config.json'), { force: true })
  _resetStorageLocationsForTests()
  initStorageLocations(testDir)
  locationId = createStorageLocation({
    id: '',
    name: '测试 R2',
    kind: 's3',
    s3: { bucket: 'b', region: 'r', accessKeyId: 'k', secretAccessKey: 's' },
  }).id
})

/** 配置多端同步（引用存储连接） */
async function configureProtocol(): Promise<void> {
  await applyProtocolManagerConfig({
    enabled: true,
    locationId,
    prefix: 'test',
  })
}

function insertDoc(id: string, title: string): void {
  insertBlock(getDb(), {
    id,
    notebook_id: notebookId,
    parent_id: null,
    root_id: id,
    type: 'document',
    content: title,
    sort: 0,
    level: 0,
    now: nowTimestamp(),
  })
}

function makeMockS3() {
  const objects = new Map<string, string>()
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

/** 手工构造一条其他设备的 v2 增量段（模拟第二写端发布） */
function putOtherDeviceSegment(objects: Map<string, string>, deviceId: string, docId: string, content: string): void {
  const now = nowTimestamp()
  const line = JSON.stringify({
    seq: 1,
    entity: 'block',
    entity_id: docId,
    is_erased: 0,
    actor: 'other',
    changed_at: now,
    device_id: deviceId,
    block: {
      id: docId, notebook_id: notebookId, parent_id: null, root_id: docId,
      type: 'document', content, properties: '{}', tags: '[]', status: 'note',
      ai_exclude: 0, sort: 0, level: 0, created_at: now, updated_at: now,
    },
  })
  objects.set(`test/${SYNC_S3_DIR}/changes/${deviceId}/0000000001-0000000001.jsonl`, line)
}

describe('sync protocol manager', () => {
  test('未配置 backup S3 时未启用，syncNow 抛 not_configured', async () => {
    initProtocolManager(testDir)
    expect(protocolStatus().configured).toBe(false)
    await expect(syncNow()).rejects.toMatchObject({ code: 'not_configured' })
  })

  test('syncNow 发布增量 → 持久化 state → S3 有本端 namespace 的 changes 对象', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    const { client, objects } = makeMockS3()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, client))

    insertDoc(crypto.randomUUID(), '同步文档')

    const result = await syncNow()
    expect(result.published).toBeGreaterThan(0)
    expect(result.state.publishedSeq).toBeGreaterThan(0)
    // S3 有本端设备分桶的 changes 对象
    expect([...objects.keys()].some((k) => k.includes(`${SYNC_S3_DIR}/changes/${getDeviceId()}/`))).toBe(true)
    // state 落盘（v2：consumed 为 per-device 高水位表）
    expect(existsSync(join(testDir, 'sync-state.json'))).toBe(true)
    const saved = JSON.parse(readFileSync(join(testDir, 'sync-state.json'), 'utf-8'))
    expect(saved.consumed).toEqual({})
    // 状态反映运行
    expect(protocolStatus().lastSuccessAt).toBeTruthy()
    expect(protocolStatus().state.publishedSeq).toBe(result.state.publishedSeq)
  })

  test('幂等：再次 syncNow 不产生重复发布（published=0）', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, makeMockS3().client))

    insertDoc(crypto.randomUUID(), '幂等文档')
    const r1 = await syncNow()
    const r2 = await syncNow()
    // 无新变更 → published 为 0
    expect(r2.published).toBe(0)
    expect(r2.state.publishedSeq).toBe(r1.state.publishedSeq)
  })

  test('空转心跳不累计 compaction：连续无变更同步不生成快照', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    const { client, objects } = makeMockS3()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, client))

    insertDoc(crypto.randomUUID(), '仅一轮有变更')
    const first = await syncNow()
    expect(first.published).toBeGreaterThan(0)
    expect(first.snapshotCreated).toBe(false)

    for (let i = 0; i < 12; i++) {
      const r = await syncNow()
      expect(r.published).toBe(0)
      expect(r.snapshotCreated).toBe(false)
    }
    expect([...objects.keys()].some((k) => k.endsWith('snapshot.db'))).toBe(false)
  })

  test('并发同步返回 sync_in_progress', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    const { client } = makeMockS3()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, client))

    insertDoc(crypto.randomUUID(), '并发文档')
    const p1 = syncNow()
    const p2 = syncNow().catch((e) => e)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.published).toBeGreaterThan(0)
    expect((r2 as { code?: string }).code).toBe('sync_in_progress')
  })

  test('累计达阈值触发 compaction：生成快照 + 清理旧增量', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    const { client, objects } = makeMockS3()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, client))

    // 每轮插入一个新文档，连续同步超过阈值
    let sawSnapshot = false
    for (let i = 0; i < 12; i++) {
      insertDoc(crypto.randomUUID(), `文档${i}`)
      const r = await syncNow()
      if (r.snapshotCreated) sawSnapshot = true
    }
    expect(sawSnapshot).toBe(true)
    // S3 有快照（snapshot.db + snapshot.meta.json）
    expect([...objects.keys()].some((k) => k.endsWith('snapshot.db'))).toBe(true)
    expect([...objects.keys()].some((k) => k.endsWith('snapshot.meta.json'))).toBe(true)
    // manifest v2：本端 devices 条目 + per-device 快照锚点
    const manifestKey = [...objects.keys()].find((k) => k.endsWith('manifest.json'))
    expect(manifestKey).toBeTruthy()
    const manifest = JSON.parse(objects.get(manifestKey!)!)
    expect(manifest.kind).toBe('sync')
    expect(manifest.version).toBe(2)
    expect(manifest.snapshot[getDeviceId()]).toBeGreaterThan(0)
    expect(manifest.devices[getDeviceId()]).toBeGreaterThan(0)
  })

  test('syncPull 增量消费：其他设备的段按 per-device 水位合并（本端 namespace 不消费）', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    const { client, objects } = makeMockS3()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, client))

    // 本端发布（生成 changes/<self>/ 段 + v2 manifest）
    insertDoc(crypto.randomUUID(), '待拉取文档')
    await syncNow()

    // 第二写端发布自己的段（本地 seq 从 1 开始，v1 会被本端高水位整段跳过）
    const otherDoc = crypto.randomUUID()
    putOtherDeviceSegment(objects, 'other-dev', otherDoc, '其他端文档')

    // 模拟消费端视角：游标清零（本端段不消费，靠 guard/LWW 幂等）
    _setProtocolStateForTests({ publishedSeq: 0, consumed: {} })

    const result = await syncPull()
    expect(result.mode).toBe('incremental')
    expect(result.applied).toBeGreaterThan(0)
    // per-device 水位推进（而非全局标量）
    expect(result.state.consumed['other-dev']).toBe(1)
    // 其他端内容合并进本地
    expect(getDb().query('SELECT content FROM blocks WHERE id = ?').get(otherDoc))
      .toEqual({ content: '其他端文档' })
    // 已持久化
    const saved = JSON.parse(readFileSync(join(testDir, 'sync-state.json'), 'utf-8'))
    expect(saved.consumed['other-dev']).toBe(1)
  })

  test('syncPull 无远端数据抛 no_remote', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, makeMockS3().client)) // 空 S3
    await expect(syncPull()).rejects.toMatchObject({ code: 'no_remote' })
  })

  test('检测到 v1 布局自动迁移：合并旧段内容、重建 v2 快照与 manifest', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    const { client, objects } = makeMockS3()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, client))

    // 手工布置 v1 布局：根级段（行内带 device_id）+ v1 manifest
    const legacyDoc = crypto.randomUUID()
    const now = nowTimestamp()
    objects.set(`test/${SYNC_S3_DIR}/changes/0000000001-0000000003.jsonl`, JSON.stringify({
      seq: 3,
      entity: 'block',
      entity_id: legacyDoc,
      is_erased: 0,
      actor: 'old',
      changed_at: now,
      device_id: 'old-dev',
      block: {
        id: legacyDoc, notebook_id: notebookId, parent_id: null, root_id: legacyDoc,
        type: 'document', content: 'v1遗留文档', properties: '{}', tags: '[]', status: 'note',
        ai_exclude: 0, sort: 0, level: 0, created_at: now, updated_at: now,
      },
    }))
    objects.set(`test/${SYNC_S3_DIR}/manifest.json`, JSON.stringify({
      app: 'notefast', kind: 'sync', version: 1, last_seq: 3, snapshot_seq: 0, updated_at: now,
    }))

    // 本端也有内容
    insertDoc(crypto.randomUUID(), '本端文档')
    await syncNow()

    // v1 旧段内容已合并进本端库
    expect(getDb().query('SELECT content FROM blocks WHERE id = ?').get(legacyDoc))
      .toEqual({ content: 'v1遗留文档' })
    // 旧设备水位被推导并持久化
    expect(protocolStatus().state.consumed['old-dev']).toBe(3)
    // manifest 升级为 v2，v1 根级段被清理
    const manifest = JSON.parse(objects.get(`test/${SYNC_S3_DIR}/manifest.json`)!)
    expect(manifest.version).toBe(2)
    expect(manifest.devices[getDeviceId()]).toBeGreaterThan(0)
    expect([...objects.keys()].some((k) => /changes\/\d{10}-\d{10}\.jsonl$/.test(k))).toBe(false)
    // 迁移触发了 v2 快照重建（含合并后的 v1 内容）
    expect(objects.has(`test/${SYNC_S3_DIR}/snapshot.meta.json`)).toBe(true)
  })

  test('scheduleSyncNow 去抖：写入后延迟触发一次 syncNow，publishedSeq 前进', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    const { client } = makeMockS3()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, client))
    _setProtocolStateForTests({ publishedSeq: 0, consumed: {} })

    // 模拟写入 → 去抖自动同步
    insertDoc(crypto.randomUUID(), '去抖同步文档')
    scheduleSyncNow()
    // 去抖窗口内 publishedSeq 未变（还没触发）
    expect(protocolStatus().state.publishedSeq).toBe(0)
    // 等去抖窗口 + 同步完成
    await new Promise((r) => setTimeout(r, 6000))
    expect(protocolStatus().state.publishedSeq).toBeGreaterThan(0)
    expect(protocolStatus().lastSuccessAt).toBeTruthy()
  }, 9000)

  test('syncNow 后设备写入注册表，可列出与移除', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    const { client } = makeMockS3()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, client))
    insertDoc(crypto.randomUUID(), '注册表文档')
    await syncNow()

    const devices = await listSyncDevices()
    expect(devices.length).toBeGreaterThanOrEqual(1)
    const self = devices.find((d) => d.device_id === getDeviceId())
    expect(self).toBeTruthy()
    expect(self!.last_seen).toBeTruthy()

    // 移除本端记录（展示性操作）
    await removeSyncDevice(getDeviceId())
    const after = await listSyncDevices()
    expect(after.find((d) => d.device_id === getDeviceId())).toBeUndefined()
  })

  test('S3 位置变化时重置 seq 锚点，避免换位置后跳过早期变更', async () => {
    initProtocolManager(testDir)
    await configureProtocol() // location=bucket b
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, makeMockS3().client))
    insertDoc(crypto.randomUUID(), '位置A文档')
    await syncNow()
    expect(protocolStatus().state.publishedSeq).toBeGreaterThan(0)

    // 换存储位置（不同 bucket 的连接）→ 重建时游标应重置为 0（从头全量发布）
    const locB2 = createStorageLocation({
      id: '',
      name: '位置 B2',
      kind: 's3',
      s3: { bucket: 'b2', region: 'r', accessKeyId: 'k', secretAccessKey: 's' },
    }).id
    await applyProtocolManagerConfig({ enabled: true, locationId: locB2, prefix: 'test' })
    expect(protocolStatus().state.publishedSeq).toBe(0)

    // 同一位置（相同 locationId + 前缀）→ 游标保留
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, makeMockS3().client))
    insertDoc(crypto.randomUUID(), '位置A再来一条')
    await syncNow()
    const anchor = protocolStatus().state.publishedSeq
    expect(anchor).toBeGreaterThan(0)
    await applyProtocolManagerConfig({ enabled: true, locationId: locB2, prefix: 'test' })
    expect(protocolStatus().state.publishedSeq).toBe(anchor)
  })

  test('feed 曾被时间裁剪且远端为空：首轮立即生成快照（新端走全量不残缺补齐）', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    const { client, objects } = makeMockS3()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, client))
    // 模拟维护任务在「未配置同步期间」裁剪过 change feed：publishedSeq=0 + feedPruned
    _setProtocolStateForTests({ publishedSeq: 0, consumed: {}, feedPruned: true })

    insertDoc(crypto.randomUUID(), '裁剪后的文档')
    const result = await syncNow()

    // 首轮即 compaction：快照 + 元数据存在，manifest.snapshot 有本端锚点
    expect(result.snapshotCreated).toBe(true)
    expect([...objects.keys()].some((k) => k.endsWith('snapshot.db'))).toBe(true)
    const manifestKey = [...objects.keys()].find((k) => k.endsWith('manifest.json'))
    expect(manifestKey).toBeTruthy()
    const manifest = JSON.parse(objects.get(manifestKey!)!)
    expect(Object.keys(manifest.snapshot)).toContain(getDeviceId())
    // feedPruned 复位（快照已兜底，不再强制）
    expect(protocolStatus().state.feedPruned).toBe(false)
    // 后续轮次回归正常：不再每轮 compact
    insertDoc(crypto.randomUUID(), '第二篇')
    const r2 = await syncNow()
    expect(r2.snapshotCreated).toBe(false)
    expect(r2.published).toBeGreaterThan(0)
  })
})
