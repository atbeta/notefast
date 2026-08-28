/**
 * 索引队列暂停 / 文档覆盖率 / HTTP
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createPluginSystem, type ProviderDefinition } from '@notefast/core'
import { initDb, closeDb, getDb } from '../db'
import { initAiRuntime, applyNewConfig, _setRuntimeForTests, getRuntime } from '../services/aiRuntime'
import { initVectorStore } from '../ai/indexer'
import { embeddingFingerprint } from '../ai/vectorStore'
import {
  scheduleDocIndex,
  getIndexJob,
  getIndexJobSummary,
  pauseIndexQueue,
  resumeIndexQueue,
  _resetIndexJobsForTests,
} from '../ai/indexJobs'
import { getDocIndexState, getNotebookIndexCoverage } from '../ai/docIndexState'
import ai from '../api/ai'

let testDir: string
let notebookId: string
let pluginSystem: ReturnType<typeof createPluginSystem>
let app: Hono

const EMBEDDING: ProviderDefinition = {
  id: 'e1',
  label: 'E',
  preset: 'custom',
  baseUrl: 'http://mock/v1',
  apiKey: 'sk-test',
  embeddingModel: 'test-emb',
  chatModel: '',
  timeoutMs: 5000,
  extraHeaders: {},
}

function mockEmbed() {
  getRuntime().setFetchImpl((async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { input?: unknown }
    const inputs: string[] = Array.isArray(body.input) ? body.input as string[] : [String(body.input ?? '')]
    return new Response(
      JSON.stringify({ data: inputs.map((_, i) => ({ embedding: [0.1, 0.2, 0.3], index: i })) }),
      { status: 200 },
    )
  }) as unknown as typeof fetch)
}

function configure(autoIndex = true) {
  applyNewConfig(
    { version: 1, chat: null, embedding: EMBEDDING, autoIndex, reranker: null },
    pluginSystem,
  )
  mockEmbed()
}

function seedDoc(title: string, body: string, extra?: { status?: string }) {
  const db = getDb()
  const now = new Date().toISOString()
  const docId = crypto.randomUUID()
  const blockId = crypto.randomUUID()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, status, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, ?, 0, 0, ?, ?)`,
  ).run(docId, notebookId, docId, title, extra?.status ?? 'note', now, now)
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'paragraph', ?, 0, 1, ?, ?)`,
  ).run(blockId, notebookId, docId, docId, body, now, now)
  return { docId, blockId }
}

async function waitReady(jobId: string, ms = 4000) {
  const deadline = Date.now() + ms
  let job = getIndexJob(jobId)!
  while ((job.state === 'pending' || job.state === 'running') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
    job = getIndexJob(jobId)!
  }
  return job
}

beforeAll(async () => {
  testDir = mkdtempSync(join('/tmp', 'notefast-index-jobs-'))
  notebookId = initDb(testDir).notebookId
  await initVectorStore()
  pluginSystem = createPluginSystem()
  initAiRuntime(pluginSystem, testDir)
  app = new Hono()
  app.route('/api/v1/ai', ai)
})

afterAll(() => {
  _setRuntimeForTests(null)
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  _resetIndexJobsForTests()
  getDb().query('DELETE FROM blocks').run()
  getDb().query('DELETE FROM block_vectors').run()
  getDb().query('DELETE FROM vector_entries').run()
  getDb().query('DELETE FROM vector_generations').run()
  getDb().query(
    `UPDATE vector_store_state
     SET active_backend = 'json', status = 'stale', model_fingerprint = NULL,
         dimension = NULL, active_generation = NULL, staging_generation = NULL,
         indexed_count = 0, error = NULL
     WHERE id = 'default'`,
  ).run()
  configure(true)
})

describe('index queue pause', () => {
  test('暂停后新作业保持 pending，继续后跑完', async () => {
    pauseIndexQueue()
    expect(getIndexJobSummary().paused).toBe(true)
    const { docId, blockId } = seedDoc('暂停', '排队正文')
    const job = scheduleDocIndex(docId, [blockId])
    expect(job).not.toBeNull()
    await new Promise((r) => setTimeout(r, 80))
    expect(getIndexJob(job!.id)?.state).toBe('pending')
    resumeIndexQueue()
    const done = await waitReady(job!.id)
    expect(done.state).toBe('ready')
    expect(getIndexJobSummary().paused).toBe(false)
  })
})

describe('getDocIndexState', () => {
  test('未索引 / 完成后覆盖率', async () => {
    const { docId, blockId } = seedDoc('覆盖', '需要向量的段落')
    const before = getDocIndexState(docId)!
    expect(before.skip_reason).toBeNull()
    // 标题根块不进覆盖率分母（检索以正文块为 chunk）
    expect(before.eligible).toBe(1)
    expect(before.indexed).toBe(0)

    const job = scheduleDocIndex(docId, [blockId])
    await waitReady(job!.id)
    const after = getDocIndexState(docId)!
    expect(after.indexed).toBeGreaterThan(0)
    expect(after.job?.state).toBe('ready')
  })

  test('inbox / 无 embedding 给出 skip_reason', () => {
    const { docId } = seedDoc('箱', '草稿', { status: 'inbox' })
    expect(getDocIndexState(docId)?.skip_reason).toBe('inbox')
  })

  test('库级覆盖率区分已齐 / 未索引，POST /gaps 补齐', async () => {
    const a = seedDoc('已齐', '这段会被索引')
    seedDoc('缺口', '这段还没向量')
    const job = scheduleDocIndex(a.docId, [a.blockId])
    await waitReady(job!.id)

    const cov = getNotebookIndexCoverage()!
    expect(cov.notes).toBe(2)
    expect(cov.ready).toBe(1)
    expect(cov.unindexed).toBe(1)

    const res = await app.request('/api/v1/ai/index/gaps', { method: 'POST' })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { queued: number }
    expect(body.queued).toBeGreaterThanOrEqual(1)
    const deadline = Date.now() + 4000
    let after = getNotebookIndexCoverage()!
    while (after.unindexed > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
      after = getNotebookIndexCoverage()!
    }
    expect(after.unindexed).toBe(0)
    expect(after.ready).toBe(2)
  })

  test('sqlite-vec 为权威时按 generation 计覆盖率，忽略过期 block_vectors', () => {
    const { docId, blockId } = seedDoc('换模型后', '重建过的正文')
    const fp = embeddingFingerprint(EMBEDDING)
    const db = getDb()
    const gen = 'coverage-gen'
    db.query(
      `INSERT INTO vector_generations (id, table_name, model_fingerprint, dimension, status)
       VALUES (?, 'vec_blocks_coverage', ?, 3, 'active')`,
    ).run(gen, fp)
    db.query(
      `INSERT INTO vector_entries
         (generation, block_id, content_hash, notebook_id, root_id, block_updated_at)
       VALUES (?, ?, 'h', ?, ?, datetime('now'))`,
    ).run(gen, blockId, notebookId, docId)
    db.query(
      `UPDATE vector_store_state
       SET active_backend = 'sqlite-vec', active_generation = ?, model_fingerprint = ?
       WHERE id = 'default'`,
    ).run(gen, fp)
    db.query(
      `INSERT INTO block_vectors (block_id, embedding, dim, embedding_model, index_version)
       VALUES (?, X'00000000', 3, 'old-fingerprint', 2)`,
    ).run(blockId)

    expect(getDocIndexState(docId)?.indexed).toBe(1)
    const cov = getNotebookIndexCoverage()!
    expect(cov.ready).toBe(1)
    expect(cov.unindexed).toBe(0)
  })

  test('sqlite-vec generation 指纹与当前模型不一致时仍算未索引', () => {
    const { docId, blockId } = seedDoc('旧模型', '还是旧向量')
    const db = getDb()
    const gen = 'stale-gen'
    db.query(
      `INSERT INTO vector_generations (id, table_name, model_fingerprint, dimension, status)
       VALUES (?, 'vec_blocks_stale', 'old-fingerprint', 3, 'active')`,
    ).run(gen)
    db.query(
      `INSERT INTO vector_entries
         (generation, block_id, content_hash, notebook_id, root_id, block_updated_at)
       VALUES (?, ?, 'h', ?, ?, datetime('now'))`,
    ).run(gen, blockId, notebookId, docId)
    db.query(
      `UPDATE vector_store_state
       SET active_backend = 'sqlite-vec', active_generation = ?, model_fingerprint = 'old-fingerprint'
       WHERE id = 'default'`,
    ).run(gen)

    expect(getDocIndexState(docId)?.indexed).toBe(0)
    expect(getNotebookIndexCoverage()?.unindexed).toBe(1)
  })
})

describe('GET/POST /ai/index/docs', () => {
  test('GET 返回覆盖率；POST 可强制调度', async () => {
    const { docId } = seedDoc('接口', '正文一段')
    const getRes = await app.request(`/api/v1/ai/index/docs/${docId}`)
    expect(getRes.status).toBe(200)
    const snap = (await getRes.json()) as { eligible: number; indexed: number }
    expect(snap.eligible).toBeGreaterThanOrEqual(1)
    expect(snap.indexed).toBe(0)

    const postRes = await app.request(`/api/v1/ai/index/docs/${docId}`, { method: 'POST' })
    expect(postRes.status).toBe(202)
    const posted = (await postRes.json()) as { index_job: { id: string } }
    expect(posted.index_job.id).toBeTruthy()
    await waitReady(posted.index_job.id)
  })

  test('缺文档 404；pause / resume 走 HTTP', async () => {
    const missing = await app.request(`/api/v1/ai/index/docs/${crypto.randomUUID()}`)
    expect(missing.status).toBe(404)
    const pauseRes = await app.request('/api/v1/ai/index/jobs/pause', { method: 'POST' })
    expect(pauseRes.status).toBe(200)
    expect(((await pauseRes.json()) as { paused: boolean }).paused).toBe(true)
    const resumeRes = await app.request('/api/v1/ai/index/jobs/resume', { method: 'POST' })
    expect(((await resumeRes.json()) as { paused: boolean }).paused).toBe(false)
  })
})
