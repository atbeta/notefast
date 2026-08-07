import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { insertBlock, updateBlock, softDeleteBlocks, restoreBlocks, nowTimestamp } from '../store/blocks'
import { listChanges, getChangesAnchor, pruneChanges } from '../store/changeFeed'

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

describe('pruneChanges（同步 compaction 裁剪）', () => {
  test('按锚点裁剪：seq <= 锚点的行删除，之后的行保留', () => {
    const db = getDb()
    insertParagraph(crypto.randomUUID())
    const anchor = getChangesAnchor(db)
    insertParagraph(crypto.randomUUID())
    insertParagraph(crypto.randomUUID())

    const before = listChanges(db)
    const deleted = pruneChanges(db, anchor)
    expect(deleted).toBe(before.filter((c) => c.seq <= anchor).length)

    const remaining = listChanges(db)
    expect(remaining.length).toBe(2)
    expect(remaining.every((c) => c.seq > anchor)).toBe(true)
  })

  test('锚点为 0 / 负数时零裁剪（未配置同步防静默漏数据的回归钉）', () => {
    const db = getDb()
    insertParagraph(crypto.randomUUID())
    const before = listChanges(db).length
    expect(before).toBeGreaterThan(0)
    // 未配置同步 / 空快照锚点时绝不能裁：首次发布会从 seq=0 全量回放
    expect(pruneChanges(db, 0)).toBe(0)
    expect(pruneChanges(db, -1)).toBe(0)
    expect(listChanges(db).length).toBe(before)
  })

  test('裁剪后新变更 seq 不回退（sqlite_sequence 不随删除重置）', () => {
    const db = getDb()
    const anchor = getChangesAnchor(db)
    expect(anchor).toBeGreaterThan(0)
    // 裁掉全部历史
    pruneChanges(db, anchor)
    expect(listChanges(db)).toEqual([])
    expect(getChangesAnchor(db)).toBe(0)

    // 新变更的 seq 从旧锚点之后继续，publish 从锚点续拉可拿到
    insertParagraph(crypto.randomUUID())
    const next = listChanges(db, { sinceSeq: anchor })
    expect(next.length).toBe(1)
    expect(next[0]!.seq).toBeGreaterThan(anchor)
  })
})
