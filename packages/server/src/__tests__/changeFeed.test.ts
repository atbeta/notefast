import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { insertBlock, updateBlock, softDeleteBlocks, restoreBlocks, nowTimestamp } from '../store/blocks'
import { listChanges, getChangesAnchor } from '../store/changeFeed'

/**
 * 变更馈送（change feed）：entity_changes 由 blocks 表 trigger 驱动，
 * seq 单调递增，是未来同步协议增量拉取的游标（不用 updated_at）。
 */

let testDir: string
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-changefeed-test-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

function insertParagraph(id: string): void {
  insertBlock(getDb(), {
    id,
    notebook_id: notebookId,
    parent_id: null,
    root_id: id,
    type: 'paragraph',
    content: `内容 ${id.slice(0, 8)}`,
    sort: 0,
    level: 0,
    now: nowTimestamp(),
  })
}

describe('change feed（entity_changes）', () => {
  test('空库锚点为 0，无变更', () => {
    const db = getDb()
    expect(getChangesAnchor(db)).toBe(0)
    expect(listChanges(db)).toEqual([])
  })

  test('insert / update / 软删除 / 恢复各产生一条变更，seq 单调递增', () => {
    const db = getDb()
    const id = crypto.randomUUID()

    insertParagraph(id)
    updateBlock(db, id, { content: '更新后的内容' })
    softDeleteBlocks(db, [id])
    restoreBlocks(db, [id])

    const changes = listChanges(db)
    expect(changes.length).toBe(4)
    expect(changes.map((c) => c.entity)).toEqual(['block', 'block', 'block', 'block'])
    expect(changes.every((c) => c.entity_id === id)).toBe(true)
    // insert=0，update=0，软删除=1（tombstone），恢复=0
    expect(changes.map((c) => c.is_erased)).toEqual([0, 0, 1, 0])

    const seqs = changes.map((c) => c.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    expect(getChangesAnchor(db)).toBe(seqs[seqs.length - 1])
  })

  test('sinceSeq 游标只返回之后的变更（不含自身）', () => {
    const db = getDb()
    const anchor1 = getChangesAnchor(db)

    insertParagraph(crypto.randomUUID())
    insertParagraph(crypto.randomUUID())

    const incremental = listChanges(db, { sinceSeq: anchor1 })
    expect(incremental.length).toBe(2)
    expect(incremental.every((c) => c.seq > anchor1)).toBe(true)
    // 游标推进到响应末尾即可继续拉下一页
    expect(getChangesAnchor(db)).toBe(incremental[incremental.length - 1]!.seq)
  })

  test('limit 截断 + 游标续拉覆盖全量', () => {
    const db = getDb()
    const anchor = getChangesAnchor(db)

    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    for (const id of ids) insertParagraph(id)

    const page1 = listChanges(db, { sinceSeq: anchor, limit: 2 })
    expect(page1.length).toBe(2)
    const page2 = listChanges(db, { sinceSeq: page1[page1.length - 1]!.seq, limit: 2 })
    expect(page2.length).toBe(1)
    expect([...page1, ...page2].map((c) => c.entity_id)).toEqual(ids)
  })
})
