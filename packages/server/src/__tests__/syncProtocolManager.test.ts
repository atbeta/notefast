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
 * 同步协议 Manager 编排：
 * - initProtocolManager 使用独立的多端同步配置（与备份解耦）
 * - syncNow = publish（本地→S3）→ consume（S3→本地）→ 持久化 state
 * - 自同步（同一库 publish+consume）LWW 幂等，无副作用
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

describe('sync protocol manager', () => {
  test('未配置 backup S3 时未启用，syncNow 抛 not_configured', async () => {
    initProtocolManager(testDir)
    expect(protocolStatus().configured).toBe(false)
    await expect(syncNow()).rejects.toMatchObject({ code: 'not_configured' })
  })

  test('syncNow 发布增量 → 持久化 state → S3 有 changes 对象', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    const { client, objects } = makeMockS3()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, client))

    insertDoc(crypto.randomUUID(), '同步文档')

    const result = await syncNow()
    expect(result.published).toBeGreaterThan(0)
    expect(result.state.publishedSeq).toBeGreaterThan(0)
    // S3 有 changes 对象
    expect([...objects.keys()].some((k) => k.includes(`${SYNC_S3_DIR}/changes/`))).toBe(true)
    // state 落盘
    expect(existsSync(join(testDir, 'sync-state.json'))).toBe(true)
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
    // S3 有快照（snapshot.db + snapshot.seq）
    expect([...objects.keys()].some((k) => k.endsWith('snapshot.db'))).toBe(true)
    expect([...objects.keys()].some((k) => k.endsWith('snapshot.seq'))).toBe(true)
    // manifest 记录快照锚点（compaction 后 snapshot_seq > 0）
    const manifestKey = [...objects.keys()].find((k) => k.endsWith('manifest.json'))
    expect(manifestKey).toBeTruthy()
    const manifest = JSON.parse(objects.get(manifestKey!)!)
    expect(manifest.kind).toBe('sync')
    expect(manifest.snapshot_seq).toBeGreaterThan(0)
    expect(manifest.last_seq).toBeGreaterThan(0)
  })

  test('syncPull 增量消费：远端 manifest 有变更且本地未落后快照时，走增量合并', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    const { client } = makeMockS3()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, client))

    // 先在本地发布一些变更（生成 changes 段 + manifest）
    insertDoc(crypto.randomUUID(), '待拉取文档')
    await syncNow()

    // 模拟消费端：已有部分数据、想从远端拉增量（consumedSeq=0，无快照落后）
    _setProtocolStateForTests({ publishedSeq: 0, consumedSeq: 0 })

    const result = await syncPull()
    expect(result.mode).toBe('incremental')
    // 消费端锚点前进（>= 远端 last_seq）
    expect(result.state.consumedSeq).toBeGreaterThan(0)
    // 已持久化
    const saved = JSON.parse(readFileSync(join(testDir, 'sync-state.json'), 'utf-8'))
    expect(saved.consumedSeq).toBe(result.state.consumedSeq)
  })

  test('syncPull 无远端数据抛 no_remote', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, makeMockS3().client)) // 空 S3
    await expect(syncPull()).rejects.toMatchObject({ code: 'no_remote' })
  })

  test('scheduleSyncNow 去抖：写入后延迟触发一次 syncNow，publishedSeq 前进', async () => {
    initProtocolManager(testDir)
    await configureProtocol()
    const { client } = makeMockS3()
    _setProtocolStoreForTests(createS3ObjectStore(S3_CFG, client))
    _setProtocolStateForTests({ publishedSeq: 0, consumedSeq: 0 })

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
})
