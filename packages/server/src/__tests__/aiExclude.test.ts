import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import {
  isDocAiExcluded,
  isBlockAiExcluded,
  writeDocAiExclude,
  loadAiExcludedDocIds,
  loadDocBlockIds,
  readDocAiExclude,
  applyAiExcludeChange,
} from '../ai/aiExclude'

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-ai-exclude-'))
  initDb(testDir)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('aiExclude helpers', () => {
  test('write / read / inherit to child blocks', () => {
    const db = getDb()
    const nb = db.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const docId = crypto.randomUUID()
    const childId = crypto.randomUUID()
    const now = new Date().toISOString()

    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', '对AI隐藏的文档', 0, 0, ?, ?)`,
    ).run(docId, nb.id, docId, now, now)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', '秘密内容', 0, 1, ?, ?)`,
    ).run(childId, nb.id, docId, docId, now, now)

    expect(isDocAiExcluded(docId)).toBe(false)
    expect(isBlockAiExcluded(childId)).toBe(false)

    const updated = writeDocAiExclude(docId, true)
    expect(updated).not.toBeNull()
    expect(isDocAiExcluded(docId)).toBe(true)
    expect(isBlockAiExcluded(childId)).toBe(true)
    expect(loadAiExcludedDocIds([docId, 'other']).has(docId)).toBe(true)

    writeDocAiExclude(docId, false)
    expect(isDocAiExcluded(docId)).toBe(false)
    expect(isBlockAiExcluded(childId)).toBe(false)
  })

  test('loadDocBlockIds 含 root 与所有子孙', () => {
    const db = getDb()
    const nb = db.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const root = crypto.randomUUID()
    const a = crypto.randomUUID()
    const b = crypto.randomUUID()
    const now = new Date().toISOString()

    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', 't', 0, 0, ?, ?)`,
    ).run(root, nb.id, root, now, now)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', 'a', 0, 1, ?, ?)`,
    ).run(a, nb.id, root, root, now, now)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', 'b', 1, 2, ?, ?)`,
    ).run(b, nb.id, a, root, now, now)

    const ids = loadDocBlockIds(root)
    expect(ids).toContain(root)
    expect(ids).toContain(a)
    expect(ids).toContain(b)
  })

  test('readDocAiExclude 在不存在时返回 null', () => {
    expect(readDocAiExclude('non-existent-id')).toBeNull()
  })

  test('applyAiExcludeChange 无变化时返回 undefined', async () => {
    const db = getDb()
    const nb = db.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const docId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', 'no-change', 0, 0, ?, ?)`,
    ).run(docId, nb.id, docId, now, now)

    const r = await applyAiExcludeChange(docId, false, false)
    expect(r).toBeUndefined()
  })

  test('applyAiExcludeChange 启用→purge / 关闭→reindex', async () => {
    const db = getDb()
    const nb = db.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const docId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', 'switch', 0, 0, ?, ?)`,
    ).run(docId, nb.id, docId, now, now)

    const enableResult = await applyAiExcludeChange(docId, false, true)
    // 向量存储未初始化时 purge 仍走 deleteVector → 但 store 未初始化会抛空；
    // applyAiExcludeChange 仅返回 purge 的 stats
    expect(enableResult).toBeDefined()
    expect(enableResult?.vectors).toBeGreaterThanOrEqual(0)

    const disableResult = await applyAiExcludeChange(docId, true, false)
    expect(disableResult).toBeDefined()
    expect(disableResult?.reindexed).toBeGreaterThanOrEqual(0)
  })
})

describe('恢复可见 → 异步索引作业', () => {
  test('不在调用内逐块 embed：立即返回 index_job，后台完成重建', async () => {
    const { createPluginSystem } = await import('@notefast/core')
    const { initAiRuntime, applyNewConfig, _setRuntimeForTests, getRuntime } = await import('../services/aiRuntime')
    const { initVectorStore } = await import('../ai/indexer')
    const { getIndexJob, _resetIndexJobsForTests } = await import('../ai/indexJobs')

    const pluginSystem = createPluginSystem()
    initAiRuntime(pluginSystem, testDir)
    applyNewConfig(
      {
        version: 1,
        chat: null,
        embedding: {
          id: 'emb-1',
          label: 'Emb',
          preset: 'custom',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          embeddingModel: 'test-embedding',
          chatModel: '',
          timeoutMs: 30_000,
          extraHeaders: {},
        },
        autoIndex: true,
        reranker: null,
      },
      pluginSystem,
    )
    await initVectorStore()

    // mock embedding API：按批量输入返回等长向量
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string)
      const inputs: unknown[] = Array.isArray(body.input) ? body.input : [body.input]
      return new Response(
        JSON.stringify({ data: inputs.map((_, i) => ({ embedding: [0.1, 0.2, 0.3], index: i })) }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    getRuntime().setFetchImpl(fetcher)

    const db = getDb()
    const nb = db.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const docId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', '恢复测试', 0, 0, ?, ?)`,
    ).run(docId, nb.id, docId, now, now)
    for (const [i, content] of ['块一', '块二'].entries()) {
      db.query(
        `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'paragraph', ?, ?, 1, ?, ?)`,
      ).run(crypto.randomUUID(), nb.id, docId, docId, content, i, now, now)
    }

    try {
      const t0 = Date.now()
      const result = await applyAiExcludeChange(docId, true, false)
      // 关键断言：调用不阻塞在逐块 embedding 上
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(result?.index_job).toBeDefined()

      const jobId = result!.index_job!.id
      let final = getIndexJob(jobId)
      const deadline = Date.now() + 5000
      while (final && (final.state === 'pending' || final.state === 'running') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        final = getIndexJob(jobId)
      }
      expect(final?.state).toBe('ready')
      expect(final!.done + final!.skipped).toBe(3)
    } finally {
      _setRuntimeForTests(null)
      _resetIndexJobsForTests()
    }
  })
})
