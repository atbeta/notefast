import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { insertBlock, nowTimestamp } from '../store/blocks'
import {
  initProtocolManager,
  syncNow,
  protocolStatus,
  _resetProtocolManagerForTests,
  _setProtocolClientForTests,
} from '../sync/protocolManager'
import { applyBackupConfig, _resetBackupConfigForTests } from '../backup/config'
import { SYNC_S3_DIR } from '@notefast/core'

/**
 * 同步协议 Manager 编排：
 * - initProtocolManager 复用 backup S3 配置
 * - syncNow = publish（本地→S3）→ consume（S3→本地）→ 持久化 state
 * - 自同步（同一库 publish+consume）LWW 幂等，无副作用
 * - state 持久化到 data/sync-state.json
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
  _resetBackupConfigForTests()
})

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
    applyBackupConfig({
      version: 1,
      enabled: true,
      intervalMs: 0,
      retentionDays: 30,
      s3: { bucket: 'b', region: 'r', accessKeyId: 'k', secretAccessKey: 's', prefix: 'test' },
    })
    const { client, objects } = makeMockS3()
    _setProtocolClientForTests(client)

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
    applyBackupConfig({
      version: 1,
      enabled: true,
      intervalMs: 0,
      retentionDays: 30,
      s3: { bucket: 'b', region: 'r', accessKeyId: 'k', secretAccessKey: 's', prefix: 'test' },
    })
    _setProtocolClientForTests(makeMockS3().client)

    insertDoc(crypto.randomUUID(), '幂等文档')
    const r1 = await syncNow()
    const r2 = await syncNow()
    // 无新变更 → published 为 0
    expect(r2.published).toBe(0)
    expect(r2.state.publishedSeq).toBe(r1.state.publishedSeq)
  })

  test('并发同步返回 sync_in_progress', async () => {
    initProtocolManager(testDir)
    applyBackupConfig({
      version: 1,
      enabled: true,
      intervalMs: 0,
      retentionDays: 30,
      s3: { bucket: 'b', region: 'r', accessKeyId: 'k', secretAccessKey: 's', prefix: 'test' },
    })
    _setProtocolClientForTests(makeMockS3().client)

    // 模拟 running 状态（syncNow 内部置位；此处直接并发触发）
    insertDoc(crypto.randomUUID(), '并发文档')
    const p1 = syncNow()
    const p2 = syncNow().catch((e) => e)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.published).toBeGreaterThan(0)
    expect((r2 as { code?: string }).code).toBe('sync_in_progress')
  })
})
