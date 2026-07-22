import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../db'
import { contentHash } from '../ai/vectorStore'
import { SqliteVecVectorStore } from '../ai/vectorStoreVec'
import { runVectorRebuild } from '../ai/vectorRebuild'

let testDir: string
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-vec-store-'))
  notebookId = initDb(testDir).notebookId
  getDb().query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content)
     VALUES ('vec-a', ?, NULL, 'vec-a', 'paragraph', 'alpha'),
            ('vec-b', ?, NULL, 'vec-b', 'paragraph', 'beta')`,
  ).run(notebookId, notebookId)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('SqliteVecVectorStore', () => {
  test('影子 generation 激活后提供精确 cosine 检索', async () => {
    const store = new SqliteVecVectorStore()
    await store.init()
    await store.createGeneration('test-generation', 'model-a', 2)
    await store.upsertToGeneration('test-generation', {
      blockId: 'vec-a',
      vector: new Float64Array([1, 0]),
      modelFingerprint: 'model-a',
      contentHash: contentHash('alpha'),
    })
    await store.upsertToGeneration('test-generation', {
      blockId: 'vec-b',
      vector: new Float64Array([0, 1]),
      modelFingerprint: 'model-a',
      contentHash: contentHash('beta'),
    })
    await store.activateGeneration('test-generation')

    const hits = await store.search(new Float64Array([1, 0]), {
      limit: 2,
      modelFingerprint: 'model-a',
      notebookId,
    })

    expect(hits.map((hit) => hit.block_id)).toEqual(['vec-a', 'vec-b'])
    expect(hits[0]!.score).toBeCloseTo(1, 5)
    expect(hits[1]!.score).toBeCloseTo(0, 5)
    expect((await store.status()).backend).toBe('sqlite-vec')
  })

  test('内容哈希不匹配的旧批次不能覆盖新向量', async () => {
    const store = new SqliteVecVectorStore()
    await store.init()
    await store.createGeneration('race-generation', 'model-a', 2)
    getDb().query("UPDATE blocks SET content = 'new alpha' WHERE id = 'vec-a'").run()

    const inserted = await store.upsertToGeneration('race-generation', {
      blockId: 'vec-a',
      vector: new Float64Array([1, 0]),
      modelFingerprint: 'model-a',
      contentHash: contentHash('alpha'),
    })

    expect(inserted).toBe(false)
  })

  test('影子重建完成后原子切换 generation', async () => {
    const before = (await new SqliteVecVectorStore().status()).activeGeneration
    const result = await runVectorRebuild({
      provider: {
        fingerprint: 'model-rebuilt',
        async embedBatch(texts) {
          return texts.map((text) => new Float64Array(
            text.includes('beta') ? [0, 1] : [1, 0],
          ))
        },
      },
    })

    expect(result.status).toBe('ready')
    expect(result.activeGeneration).not.toBe(before)
    expect(result.count).toBe(2)

    const store = new SqliteVecVectorStore()
    const hits = await store.search(new Float64Array([0, 1]), {
      limit: 2,
      modelFingerprint: 'model-rebuilt',
    })
    expect(hits[0]!.block_id).toBe('vec-b')
  })

  test('直接删除 block 时同步清理 vec0 行', async () => {
    const db = getDb()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content)
       VALUES ('vec-delete', ?, NULL, 'vec-delete', 'paragraph', 'delete me')`,
    ).run(notebookId)
    const store = new SqliteVecVectorStore()
    await store.upsert({
      blockId: 'vec-delete',
      vector: new Float64Array([1, 0]),
      modelFingerprint: 'model-rebuilt',
      contentHash: contentHash('delete me'),
    })
    const mapping = db.query(
      `SELECT e.id, g.table_name
       FROM vector_entries e
       JOIN vector_generations g ON g.id = e.generation
       WHERE e.block_id = 'vec-delete' AND g.status = 'active'`,
    ).get() as { id: number; table_name: string }

    db.query("DELETE FROM blocks WHERE id = 'vec-delete'").run()

    const row = db.query(
      `SELECT count(*) AS count FROM ${mapping.table_name} WHERE rowid = ?`,
    ).get(mapping.id) as { count: number }
    expect(row.count).toBe(0)
  })
})
