import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import {
  isDocAiExcluded,
  isBlockAiExcluded,
  writeDocAiExclude,
  loadAiExcludedDocIds,
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
})
