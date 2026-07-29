/**
 * 向量全量重建 单元测试
 *
 * 验证：
 * - 软删除块不进 staging（P0 回归：重建 SQL 过滤 is_deleted）
 * - 重建与增量索引共用 buildIndexedText：索引文本一致（含标题/章节/标签/caption），
 *   重建后 indexBlock 判 fresh（skipped）——双 hash 下 vec 后端自校验不再误拒
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { createPluginSystem } from '@notefast/core'
import {
  initAiRuntime,
  applyNewConfig,
  _setRuntimeForTests,
  getRuntime,
} from '../services/aiRuntime'
import { initVectorStore, indexBlock } from '../ai/indexer'
import { runVectorRebuild } from '../ai/vectorRebuild'
import { contentHash, embeddingFingerprint } from '../ai/vectorStore'
import { SqliteVecVectorStore } from '../ai/vectorStoreVec'
import { getBlockById } from '../store/blocks'

let testDir: string
let notebookId: string
let pluginSystem: ReturnType<typeof createPluginSystem>

let embedInputs: string[] = []

const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
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

const EMBEDDING_PROVIDER = {
  id: 'e1',
  label: 'E',
  preset: 'custom' as const,
  baseUrl: 'http://mock/v1',
  apiKey: 'sk-test',
  embeddingModel: 'test-emb',
  chatModel: '',
  timeoutMs: 5000,
  extraHeaders: {},
}

function configure(vision: boolean) {
  applyNewConfig(
    {
      version: 1,
      chat: vision
        ? {
            id: 'c1',
            label: 'C',
            preset: 'custom',
            baseUrl: 'http://mock/v1',
            apiKey: 'sk-test',
            embeddingModel: '',
            chatModel: 'vision-chat',
            timeoutMs: 5000,
            extraHeaders: {},
          }
        : null,
      embedding: EMBEDDING_PROVIDER,
      autoIndex: false,
      reranker: null,
      vision: vision ? { enabled: true } : undefined,
    },
    pluginSystem,
  )
  getRuntime().setFetchImpl(fetcher)
}

beforeAll(async () => {
  testDir = mkdtempSync(join('/tmp', 'notefast-rebuild-'))
  notebookId = initDb(testDir).notebookId
  pluginSystem = createPluginSystem()
  initAiRuntime(pluginSystem, testDir)
  await initVectorStore()
})

afterAll(() => {
  _setRuntimeForTests(null)
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  embedInputs = []
  getDb().query('DELETE FROM blocks').run()
  getDb().query('DELETE FROM asset_captions').run()
})

function seed(opts: {
  docId: string
  title: string
  tags?: string
  blocks: Array<{ id: string; parentId: string; type?: string; content: string }>
}) {
  const db = getDb()
  const now = new Date().toISOString()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, tags, status, ai_exclude, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, ?, 'note', 0, 0, 0, ?, ?)`,
  ).run(opts.docId, notebookId, opts.docId, opts.title, opts.tags ?? '[]', now, now)
  for (const b of opts.blocks) {
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
    ).run(b.id, notebookId, b.parentId, opts.docId, b.type ?? 'paragraph', b.content, now, now)
  }
}

describe('runVectorRebuild', () => {
  test('软删除块不进 staging（重建 SQL 过滤 is_deleted）', async () => {
    configure(false)
    const docId = crypto.randomUUID()
    seed({
      docId,
      title: 'T',
      blocks: [
        { id: 'live-block', parentId: docId, content: '活着的内容' },
        { id: 'dead-block', parentId: docId, content: '已删除的幽灵内容' },
      ],
    })
    getDb().query('UPDATE blocks SET is_deleted = 1 WHERE id = ?').run('dead-block')

    const status = await runVectorRebuild()
    expect(status.status).toBe('ready')
    // doc 根 + live-block = 2；dead-block 不参与
    expect(status.count).toBe(2)
    expect(embedInputs.join('\n')).not.toContain('已删除的幽灵内容')

    const fingerprint = embeddingFingerprint(getRuntime().embeddingProviderDef()!)
    const hits = await new SqliteVecVectorStore().search(new Float64Array([0.1, 0.2, 0.3]), {
      limit: 10,
      modelFingerprint: fingerprint,
    })
    expect(hits.map((h) => h.block_id)).not.toContain('dead-block')
  })

  test('重建与增量索引文本一致：上下文 + caption，重建后 indexBlock 判 fresh', async () => {
    configure(true)
    const assetId = 'a'.repeat(64)
    getDb()
      .query('INSERT INTO asset_captions (id, caption, model, created_at) VALUES (?, ?, ?, ?)')
      .run(assetId, '一张缓存的架构图', 'vision-chat', new Date().toISOString())

    const docId = crypto.randomUUID()
    const headingId = crypto.randomUUID()
    const blockId = crypto.randomUUID()
    seed({
      docId,
      title: '架构笔记',
      tags: '["infra"]',
      blocks: [
        { id: headingId, parentId: docId, type: 'heading', content: '第一章' },
        { id: blockId, parentId: headingId, content: `正文引用图 ![a](asset:${assetId})` },
      ],
    })

    const status = await runVectorRebuild()
    expect(status.status).toBe('ready')

    // 重建的 embed 输入 = 构建器输出（标题/章节/标签/正文/caption 全含）
    const text = embedInputs.find((t) => t.includes('正文引用图'))
    expect(text).toBeDefined()
    expect(text).toContain('标题：架构笔记')
    expect(text).toContain('章节：第一章')
    expect(text).toContain('标签：infra')
    expect(text).toContain('[图片描述] 一张缓存的架构图')

    // 双 hash：vector_entries 同时记录索引文本 hash 与原文 hash
    const entry = getDb()
      .query('SELECT content_hash, source_content_hash FROM vector_entries WHERE block_id = ?')
      .get(blockId) as { content_hash: string; source_content_hash: string }
    const raw = getBlockById(getDb(), blockId)!
    expect(entry.source_content_hash).toBe(contentHash(raw.content))
    expect(entry.content_hash).not.toBe(entry.source_content_hash)

    // 增量路径同构建器 → hash 一致 → 判 fresh（不再重复 embed）
    embedInputs = []
    expect(await indexBlock(blockId)).toBe('skipped')
    expect(embedInputs.length).toBe(0)
  })
})
