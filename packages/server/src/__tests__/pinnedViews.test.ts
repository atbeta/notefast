import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb } from '../db'
import {
  buildPinnedViewQuery,
  createPinnedView,
  deletePinnedView,
  listPinnedViews,
  MAX_PINNED_VIEWS,
  PinnedViewError,
  subscribePinnedViewsChanges,
  updatePinnedView,
} from '../services/pinnedViews'
import pinnedViewsRouter from '../api/pinnedViews'
import eventsRouter from '../api/events'

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-pinned-views-'))
  initDb(testDir)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('buildPinnedViewQuery', () => {
  test('tags 编译为 tags=a,b（小写）', () => {
    expect(buildPinnedViewQuery({ name: 'n', tags: ['Work', 'AI'] })).toBe('tags=work%2Cai')
  })

  test('untagged 优先于 tags', () => {
    expect(buildPinnedViewQuery({ name: 'n', untagged: true, tags: ['work'] })).toBe('untagged=1')
  })

  test('原始 query 优先，并去掉 ? 前缀', () => {
    expect(buildPinnedViewQuery({ name: 'n', query: '?tags=work', tags: ['life'] })).toBe('tags=work')
  })

  test('无筛选 → invalid_params', () => {
    expect(() => buildPinnedViewQuery({ name: 'n' })).toThrow(PinnedViewError)
  })
})

describe('createPinnedView / list / delete', () => {
  test('创建、按 query 去重、取消', () => {
    const a = createPinnedView({ name: '工作', tags: ['work'] })
    expect(a.created).toBe(true)
    expect(a.view.query).toBe('tags=work')

    const dup = createPinnedView({ name: '工作重复', query: 'tags=work' })
    expect(dup.created).toBe(false)
    expect(dup.view.id).toBe(a.view.id)

    expect(listPinnedViews().some((v) => v.id === a.view.id)).toBe(true)
    expect(deletePinnedView(a.view.id)).toBe(true)
    expect(deletePinnedView(a.view.id)).toBe(false)
  })

  test('空 name → invalid_params', () => {
    expect(() => createPinnedView({ name: '  ', tags: ['x'] })).toThrow(PinnedViewError)
  })
})

describe('固定视图变更广播', () => {
  test('新建/改名/删除会通知；按 query 去重不通知', () => {
    let n = 0
    const unsub = subscribePinnedViewsChanges(() => { n++ })
    try {
      const a = createPinnedView({ name: '广播', tags: ['broadcast'] })
      expect(n).toBe(1)
      createPinnedView({ name: '广播2', query: 'tags=broadcast' })
      expect(n).toBe(1)
      updatePinnedView(a.view.id, { name: '广播改名' })
      expect(n).toBe(2)
      expect(deletePinnedView(a.view.id)).toBe(true)
      expect(n).toBe(3)
      expect(deletePinnedView(a.view.id)).toBe(false)
      expect(n).toBe(3)
    } finally {
      unsub()
    }
  })
})

describe('GET /events pinned_views 帧', () => {
  test('新建固定视图 → SSE event: pinned_views', async () => {
    const app = new Hono()
    app.route('/events', eventsRouter)
    const res = await app.fetch(new Request('http://localhost/events'))
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const created = createPinnedView({ name: 'sse-pin', tags: ['sse-pin'] })
    const read = reader.read()
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('SSE pinned_views 首帧超时')), 2000),
    )
    const { value } = await Promise.race([read, timeout])
    const text = decoder.decode(value)
    await reader.cancel()
    deletePinnedView(created.view.id)

    expect(text).toContain('event: pinned_views')
    expect(text).toContain('"at"')
  })
})


describe('REST /pinned-views', () => {
  test('POST / GET / DELETE 往返', async () => {
    const app = new Hono()
    app.route('/', pinnedViewsRouter)

    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '过时', query: 'stale_within=90d' }),
    })
    expect(created.status).toBe(201)
    const row = (await created.json()) as { id: string; name: string; query: string }
    expect(row.query).toBe('stale_within=90d')

    const list = await app.request('/')
    expect(list.status).toBe(200)
    const views = (await list.json()) as Array<{ id: string }>
    expect(views.some((v) => v.id === row.id)).toBe(true)

    const again = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '过时2', query: 'stale_within=90d' }),
    })
    expect(again.status).toBe(200)

    const del = await app.request(`/${row.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
  })
})

describe('MAX_PINNED_VIEWS', () => {
  test('超额拒绝', () => {
    const created: string[] = []
    try {
      const n = listPinnedViews().length
      for (let i = n; i < MAX_PINNED_VIEWS; i++) {
        created.push(createPinnedView({ name: `v${i}`, query: `tags=limit-${i}` }).view.id)
      }
      expect(() => createPinnedView({ name: 'overflow', query: 'tags=overflow' })).toThrow(PinnedViewError)
    } finally {
      for (const id of created) deletePinnedView(id)
    }
  })
})
