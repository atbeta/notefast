/**
 * docEvents：block 级 hooks → doc 级事件聚合广播 + SSE 端点
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createPluginSystem, rowToBlock } from '@notefast/core'
import type { BlockRow } from '@notefast/core'
import { initDb, closeDb, getDb } from '../db'
import { insertDocFromMarkdown } from '../services/docImport'
import {
  initDocEvents,
  subscribeDocChanges,
  publishDocChange,
  FLUSH_MS,
  type DocChangeEvent,
} from '../services/docEvents'
import eventsRouter from '../api/events'

let testDir: string
let notebookId: string
let pluginSystem: ReturnType<typeof createPluginSystem>

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-docevents-test-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
  pluginSystem = createPluginSystem()
  initDocEvents(pluginSystem)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

// bun test 全部文件共享一个进程，docEvents 的 pending/定时器是模块级全局：
// 其它测试文件（真实 API 写路径）发布的事件会残留并 flush 进本文件的订阅。
// 因此 collect 按 docId 过滤，且每个用例开始前先 drain 一个聚合窗口清掉残留。
function collect(docId: string): { events: DocChangeEvent[]; unsubscribe: () => void } {
  const events: DocChangeEvent[] = []
  const unsubscribe = subscribeDocChanges((ev) => { if (ev.doc_id === docId) events.push(ev) })
  return { events, unsubscribe }
}

const waitFlush = () => new Promise((r) => setTimeout(r, FLUSH_MS + 150))

describe('docEvents 聚合广播', () => {
  beforeEach(async () => { await waitFlush() })

  test('创建文档：doc + N 个子块的 afterCreate 聚合为单条 created', async () => {
    const db = getDb()
    const { docId, blockIds } = insertDocFromMarkdown(db, {
      notebookId,
      title: '事件测试',
      markdown: '第一段\n\n第二段\n\n第三段',
    })

    const { events, unsubscribe } = collect(docId)
    const docRow = db.query('SELECT * FROM blocks WHERE id = ?').get(docId) as BlockRow
    await pluginSystem.note.afterCreate.call(rowToBlock(docRow))
    for (const bid of blockIds) {
      const row = db.query('SELECT * FROM blocks WHERE id = ?').get(bid) as BlockRow
      await pluginSystem.note.afterCreate.call(rowToBlock(row))
    }
    await waitFlush()
    unsubscribe()

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('created')
  })

  test('子块更新：归属 root_id 文档，kind=updated', async () => {
    const db = getDb()
    const { docId, blockIds } = insertDocFromMarkdown(db, {
      notebookId,
      title: '更新测试',
      markdown: '一段内容',
    })

    const { events, unsubscribe } = collect(docId)
    const row = db.query('SELECT * FROM blocks WHERE id = ?').get(blockIds[0]) as BlockRow
    await pluginSystem.note.afterUpdate.call(rowToBlock(row))
    await waitFlush()
    unsubscribe()

    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({ doc_id: docId, kind: 'updated' })
  })

  test('整篇删除：document 块 afterDelete → kind=deleted（软删除行回查）', async () => {
    const db = getDb()
    const { docId } = insertDocFromMarkdown(db, {
      notebookId,
      title: '删除测试',
      markdown: '待删除',
    })
    db.query('UPDATE blocks SET is_deleted = 1 WHERE root_id = ?').run(docId)

    const { events, unsubscribe } = collect(docId)
    await pluginSystem.note.afterDelete.call(docId)
    await waitFlush()
    unsubscribe()

    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({ doc_id: docId, kind: 'deleted' })
  })

  test('子块删除：归属文档的 updated，而非 deleted', async () => {
    const db = getDb()
    const { docId, blockIds } = insertDocFromMarkdown(db, {
      notebookId,
      title: '子块删除测试',
      markdown: '一段内容',
    })
    db.query('UPDATE blocks SET is_deleted = 1 WHERE id = ?').run(blockIds[0])

    const { events, unsubscribe } = collect(docId)
    await pluginSystem.note.afterDelete.call(blockIds[0])
    await waitFlush()
    unsubscribe()

    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({ doc_id: docId, kind: 'updated' })
  })

  test('同窗口 created + updated 合并为 created；退订后不再接收', async () => {
    const db = getDb()
    const { docId, blockIds } = insertDocFromMarkdown(db, {
      notebookId,
      title: '合并测试',
      markdown: '内容',
    })

    const { events, unsubscribe } = collect(docId)
    const docRow = db.query('SELECT * FROM blocks WHERE id = ?').get(docId) as BlockRow
    await pluginSystem.note.afterCreate.call(rowToBlock(docRow))
    const childRow = db.query('SELECT * FROM blocks WHERE id = ?').get(blockIds[0]) as BlockRow
    await pluginSystem.note.afterUpdate.call(rowToBlock(childRow))
    await waitFlush()

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('created')

    publishDocChange(docId, 'updated')
    await waitFlush()
    expect(events.length).toBe(2)
    unsubscribe()
    publishDocChange(docId, 'updated')
    await waitFlush()
    expect(events.length).toBe(2)
  })
})

describe('GET /events SSE 端点', () => {
  test('doc 事件以 SSE 帧推送', async () => {
    await waitFlush() // drain 同进程其它文件残留的 pending/定时器，避免陈旧帧抢先到达
    const app = new Hono()
    app.route('/events', eventsRouter)

    const res = await app.fetch(new Request('http://localhost/events'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    publishDocChange('doc-sse-smoke', 'created')

    // 等聚合窗口 flush 后读到首帧
    const read = reader.read()
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('SSE 首帧超时')), FLUSH_MS + 2000),
    )
    const { value } = await Promise.race([read, timeout])
    const text = decoder.decode(value)
    await reader.cancel()

    expect(text).toContain('event: doc')
    expect(text).toContain('"doc_id":"doc-sse-smoke"')
    expect(text).toContain('"kind":"created"')
  })
})
