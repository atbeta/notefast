import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../db'
import {
  JsonVectorStore,
  contentHash,
  embeddingFingerprint,
} from '../ai/vectorStore'

let testDir: string
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-vector-store-'))
  notebookId = initDb(testDir).notebookId
})

beforeEach(() => {
  getDb().query('DELETE FROM block_vectors').run()
  getDb().query('DELETE FROM blocks').run()
  getDb().query(
    `UPDATE vector_store_state
     SET active_backend = 'json', status = 'stale', model_fingerprint = NULL,
         dimension = NULL, indexed_count = 0, error = NULL
     WHERE id = 'default'`,
  ).run()
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

function seedBlock(id: string, content: string): void {
  getDb().query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content)
     VALUES (?, ?, NULL, ?, 'paragraph', ?)`,
  ).run(id, notebookId, id, content)
}

describe('向量元数据', () => {
  test('模型指纹不包含密钥且对配置变化敏感', () => {
    const a = embeddingFingerprint({
      baseUrl: 'https://embed.example.com/v1/',
      embeddingModel: 'model-a',
      apiKey: 'secret-a',
    })
    const same = embeddingFingerprint({
      baseUrl: 'https://embed.example.com/v1',
      embeddingModel: 'model-a',
      apiKey: 'secret-b',
    })
    const changed = embeddingFingerprint({
      baseUrl: 'https://embed.example.com/v1',
      embeddingModel: 'model-b',
      apiKey: 'secret-a',
    })

    expect(a).toBe(same)
    expect(a).not.toContain('secret')
    expect(a).not.toBe(changed)
  })

  test('JSON store 写入模型、内容哈希和索引版本', async () => {
    seedBlock('block-a', 'alpha')
    const store = new JsonVectorStore()
    await store.init()
    await store.upsert({
      blockId: 'block-a',
      vector: new Float64Array([1, 0]),
      modelFingerprint: 'model-a',
      contentHash: contentHash('alpha'),
    })

    const row = getDb().query(
      `SELECT embedding_model, content_hash, index_version, updated_at
       FROM block_vectors WHERE block_id = ?`,
    ).get('block-a') as Record<string, string | number>

    expect(row.embedding_model).toBe('model-a')
    expect(row.content_hash).toBe(contentHash('alpha'))
    expect(row.index_version).toBe(2)
    expect(row.updated_at).not.toBe('')
  })

  test('软删除 block 的向量不参与检索（幽灵向量隔离）', async () => {
    seedBlock('live', 'live content')
    seedBlock('ghost', 'ghost content')
    const store = new JsonVectorStore()
    await store.init()
    await store.upsert({
      blockId: 'live',
      vector: new Float64Array([1, 0]),
      modelFingerprint: 'model-a',
      contentHash: contentHash('live content'),
    })
    await store.upsert({
      blockId: 'ghost',
      vector: new Float64Array([1, 0]),
      modelFingerprint: 'model-a',
      contentHash: contentHash('ghost content'),
    })
    // 软删除后（向量行未清理的场景）检索仍不得命中
    getDb().query('UPDATE blocks SET is_deleted = 1 WHERE id = ?').run('ghost')

    const hits = await store.search(new Float64Array([1, 0]), {
      limit: 10,
      modelFingerprint: 'model-a',
    })
    expect(hits.map((h) => h.block_id)).toEqual(['live'])
  })

  test('模型不匹配或 legacy 向量不会参与检索', async () => {
    seedBlock('current', 'current content')
    seedBlock('legacy', 'legacy content')
    const store = new JsonVectorStore()
    await store.init()
    await store.upsert({
      blockId: 'current',
      vector: new Float64Array([1, 0]),
      modelFingerprint: 'model-a',
      contentHash: contentHash('current content'),
    })
    getDb().query(
      'INSERT INTO block_vectors (block_id, embedding, dim) VALUES (?, ?, ?)',
    ).run('legacy', '[1,0]', 2)

    expect(await store.search(new Float64Array([1, 0]), {
      limit: 10,
      modelFingerprint: 'model-b',
    })).toEqual([])
    expect((await store.search(new Float64Array([1, 0]), {
      limit: 10,
      modelFingerprint: 'model-a',
    })).map((hit) => hit.block_id)).toEqual(['current'])
  })
})
