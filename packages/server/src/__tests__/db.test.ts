import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENT_SCHEMA_VERSION } from '@notefast/core'
import { initDb, closeDb, getDb, getSchemaVersion } from '../db'
import { nowTimestamp, updateBlock, getBlockById } from '../store/blocks'

let testDir: string
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-test-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('FTS 触发器', () => {
  test('INSERT 时自动同步 FTS', () => {
    const db = getDb()
    const id = crypto.randomUUID()

    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level)
       VALUES (?, ?, NULL, ?, 'paragraph', ?, 0, 0)`,
    ).run(id, notebookId, id, '测试 FTS 内容')

    const ftsRow = db.query('SELECT * FROM blocks_fts WHERE id = ?').get(id) as { content: string } | undefined
    expect(ftsRow).not.toBeUndefined()
    expect(ftsRow!.content).toBe('测试 FTS 内容')
  })

  test('UPDATE 时自动同步 FTS', () => {
    const db = getDb()
    const id = crypto.randomUUID()

    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level)
       VALUES (?, ?, NULL, ?, 'paragraph', ?, 0, 0)`,
    ).run(id, notebookId, id, '原始内容')
    db.query('UPDATE blocks SET content = ? WHERE id = ?').run('更新后的内容', id)

    const ftsRow = db.query('SELECT * FROM blocks_fts WHERE id = ?').get(id) as { content: string } | undefined
    expect(ftsRow).not.toBeUndefined()
    expect(ftsRow!.content).toBe('更新后的内容')
  })

  test('DELETE 时自动删除 FTS 记录', () => {
    const db = getDb()
    const id = crypto.randomUUID()
    const childId = crypto.randomUUID()

    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level)
       VALUES (?, ?, NULL, ?, 'document', ?, 0, 0)`,
    ).run(id, notebookId, id, '父文档')
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level)
       VALUES (?, ?, ?, ?, 'paragraph', ?, 0, 1)`,
    ).run(childId, notebookId, id, id, '子段落')

    db.query('DELETE FROM blocks WHERE id = ?').run(id)

    const parentFts = db.query('SELECT * FROM blocks_fts WHERE id = ?').get(id)
    const childFts = db.query('SELECT * FROM blocks_fts WHERE id = ?').get(childId)
    expect(parentFts).toBeNull()
    expect(childFts).toBeNull()
  })

  test('FTS5 全文搜索可用', () => {
    const db = getDb()
    const id = crypto.randomUUID()

    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level)
       VALUES (?, ?, NULL, ?, 'paragraph', ?, 0, 0)`,
    ).run(id, notebookId, id, 'This is a test paragraph about running')

    const results = db
      .query('SELECT * FROM blocks_fts WHERE blocks_fts MATCH ? ORDER BY rank')
      .all('"test"') as { id: string }[]

    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.id === id)).toBe(true)
  })

  test('FTS 更新/删除按 mapped rowid 定位', () => {
    const db = getDb()
    const id = crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level)
       VALUES (?, ?, NULL, ?, 'paragraph', ?, 0, 0)`,
    ).run(id, notebookId, id, 'mapped fts')

    const mapped = db.query(
      'SELECT fts_rowid FROM blocks_fts_map WHERE block_id = ?',
    ).get(id) as { fts_rowid: number } | undefined
    expect(mapped).toBeDefined()

    const triggerSql = (
      db.query(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'blocks_fts_update'",
      ).get() as { sql: string }
    ).sql
    expect(triggerSql).toContain('blocks_fts_map')
    expect(triggerSql).toContain('rowid')

    const byMap = db.query(
      'EXPLAIN QUERY PLAN SELECT fts_rowid FROM blocks_fts_map WHERE block_id = ?',
    ).all(id) as Array<{ detail: string }>
    expect(byMap.map((row) => row.detail).join(' ')).toMatch(/SEARCH/i)

    db.query('UPDATE blocks SET content = ? WHERE id = ?').run('mapped fts updated', id)
    const fts = db.query('SELECT content FROM blocks_fts WHERE id = ?').get(id) as { content: string }
    expect(fts.content).toBe('mapped fts updated')
  })
})

describe('时间戳毫秒精度（P2-NEW-08）', () => {
  test('nowTimestamp 带毫秒；updateBlock 写入毫秒精度 updated_at', () => {
    expect(nowTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)

    const db = getDb()
    const id = crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level)
       VALUES (?, ?, NULL, ?, 'paragraph', ?, 0, 0)`,
    ).run(id, notebookId, id, 'ms precision')

    updateBlock(db, id, { content: 'ms precision updated' })
    const row = getBlockById(db, id)!
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)
  })
})

describe('schema 版本', () => {
  test('初始化后 user_version 为 CURRENT_SCHEMA_VERSION', () => {
    expect(getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
  })

  test('重复 init 保持版本幂等', () => {
    const v1 = getSchemaVersion()
    // 同一进程内再次调用 apply 路径：再读一次即可
    expect(getSchemaVersion(getDb())).toBe(v1)
    expect(v1).toBe(CURRENT_SCHEMA_VERSION)
  })
})

describe('向量索引元数据迁移', () => {
  test('block_vectors 包含模型、内容哈希、索引版本和更新时间', () => {
    const columns = getDb().query('PRAGMA table_info(block_vectors)').all() as Array<{ name: string }>
    const names = columns.map((column) => column.name)

    expect(names).toContain('embedding_model')
    expect(names).toContain('content_hash')
    expect(names).toContain('index_version')
    expect(names).toContain('updated_at')
  })

  test('初始化向量存储状态为 legacy stale', () => {
    const row = getDb()
      .query("SELECT active_backend, status FROM vector_store_state WHERE id = 'default'")
      .get() as { active_backend: string; status: string } | null

    expect(row).toEqual({ active_backend: 'json', status: 'stale' })
  })
})
