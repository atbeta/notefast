import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'

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
})
