/**
 * 图片理解（索引时 caption）集成测试
 *
 * 验证：
 * - vision 开启 + chat 可用时，captionForAsset 生成并缓存 caption（不重复调用）
 * - vision 未开启时返回 null（降级为纯文本索引）
 * - indexBlock 的 embed 输入含 caption，且 freshness 与之一致（二次索引 skipped）
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createPluginSystem } from '@notefast/core'
import { initDb, closeDb, getDb } from '../db'
import { initAssetStore, saveAsset } from '../assets/store'
import {
  initAiRuntime,
  applyNewConfig,
  _setRuntimeForTests,
  getRuntime,
} from '../services/aiRuntime'
import { initVectorStore, indexBlock } from '../ai/indexer'
import { captionForAsset, getCachedCaption, visionEnabled } from '../ai/imageCaptions'

let testDir: string
let notebookId: string
let pluginSystem: ReturnType<typeof createPluginSystem>
let assetId: string

const CAPTION = '一张系统架构图，包含网关、服务层与 SQLite 数据库'

let chatCalls = 0
let embedInputs: string[] = []

const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/chat/completions')) {
    chatCalls++
    return new Response(
      JSON.stringify({ choices: [{ message: { content: CAPTION } }] }),
      { status: 200 },
    )
  }
  if (url.includes('/embeddings')) {
    const body = JSON.parse(init!.body as string)
    const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input]
    embedInputs.push(...inputs)
    return new Response(
      JSON.stringify({ data: inputs.map((_, i) => ({ embedding: [0.1, 0.2, 0.3], index: i })) }),
      { status: 200 },
    )
  }
  return new Response('not found', { status: 404 })
}) as unknown as typeof fetch

function configure(vision: boolean) {
  applyNewConfig(
    {
      version: 1,
      chat: {
        id: 'c1',
        label: 'C',
        preset: 'custom',
        baseUrl: 'http://mock/v1',
        apiKey: 'sk-test',
        embeddingModel: '',
        chatModel: 'vision-chat',
        timeoutMs: 5000,
        extraHeaders: {},
      },
      embedding: {
        id: 'e1',
        label: 'E',
        preset: 'custom',
        baseUrl: 'http://mock/v1',
        apiKey: 'sk-test',
        embeddingModel: 'test-emb',
        chatModel: '',
        timeoutMs: 5000,
        extraHeaders: {},
      },
      autoIndex: true,
      reranker: null,
      vision: vision ? { enabled: true } : undefined,
    },
    pluginSystem,
  )
  getRuntime().setFetchImpl(fetcher)
}

beforeAll(async () => {
  testDir = mkdtempSync(join('/tmp', 'notefast-imagecaptions-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
  initAssetStore(testDir)
  pluginSystem = createPluginSystem()
  initAiRuntime(pluginSystem, testDir)
  await initVectorStore()

  // 存一张「图片」（字节内容随意，mime 决定图片身份）
  assetId = saveAsset(Buffer.from('fake-png-bytes'), 'image/png').meta.id
})

afterAll(() => {
  _setRuntimeForTests(null)
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('asset_captions 缓存', () => {
  test('migration：asset_captions 表存在', () => {
    const row = getDb()
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'asset_captions'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('asset_captions')
  })

  test('vision 开启时生成并缓存 caption（不重复调用模型）', async () => {
    configure(true)
    expect(visionEnabled()).toBe(true)

    chatCalls = 0
    const first = await captionForAsset(assetId)
    expect(first).toBe(CAPTION)
    expect(chatCalls).toBe(1)
    expect(getCachedCaption(assetId)).toBe(CAPTION)

    const second = await captionForAsset(assetId)
    expect(second).toBe(CAPTION)
    expect(chatCalls).toBe(1) // 缓存命中，不再调用
  })

  test('vision 未开启时不生成 caption', async () => {
    configure(false)
    expect(visionEnabled()).toBe(false)
    const noCache = await captionForAsset('f'.repeat(64))
    expect(noCache).toBeNull()
  })
})

describe('indexBlock 拼接 caption', () => {
  test('含图片引用的块：embed 输入含 caption，二次索引 skipped', async () => {
    configure(true)
    const db = getDb()
    const docId = crypto.randomUUID()
    const blockId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', '图片文档', 0, 0, ?, ?)`,
    ).run(docId, notebookId, docId, now, now)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', ?, 0, 1, ?, ?)`,
    ).run(blockId, notebookId, docId, docId, `架构图 ![arch](asset:${assetId})`, now, now)

    embedInputs = []
    const r1 = await indexBlock(blockId)
    expect(r1).toBe('indexed')
    expect(embedInputs.length).toBe(1)
    expect(embedInputs[0]).toContain('架构图')
    expect(embedInputs[0]).toContain('[图片描述]')
    expect(embedInputs[0]).toContain(CAPTION)

    // freshness 以拼接 caption 后的文本计算 → 内容未变时跳过
    const r2 = await indexBlock(blockId)
    expect(r2).toBe('skipped')
  })
})
