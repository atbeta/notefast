import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb } from '../db'
import { createPluginSystem, type DocumentEventPayload } from '@notefast/core'
import { initAiRuntime, _setRuntimeForTests } from '../services/aiRuntime'
import docsRouter from '../api/docs'
import importRouter from '../api/import'

/**
 * 文档级生命周期钩子（doc.*）：
 * - 创建 / 状态变更 / 打标签 / 分享开启关闭 / 删除 / 导入 都触发对应 hook
 * - payload 含 doc（文档根 block）+ before（旧状态）+ meta（操作详情）
 */

let testDir: string
let pluginSystem: ReturnType<typeof createPluginSystem>
let app: Hono
let notebookId: string

const events: Array<{ hook: string; payload: DocumentEventPayload }> = []

function tapAll(): void {
  const sys = pluginSystem.doc
  ;(['afterCreate', 'afterStatusChange', 'afterTagChange', 'afterShare', 'afterShareRevoked', 'afterDelete'] as const).forEach((hook) => {
    sys[hook].tap('doc-hook-test', (payload: DocumentEventPayload) => {
      events.push({ hook, payload })
    })
  })
}

function untapAll(): void {
  const sys = pluginSystem.doc
  ;(['afterCreate', 'afterStatusChange', 'afterTagChange', 'afterShare', 'afterShareRevoked', 'afterDelete'] as const).forEach((hook) => {
    sys[hook].untap('doc-hook-test')
  })
}

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-dochook-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
  pluginSystem = createPluginSystem()
  app = new Hono()
  app.route('/docs', docsRouter)
  app.route('/import', importRouter)
})

afterAll(() => {
  _setRuntimeForTests(null)
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  events.length = 0
  _setRuntimeForTests(null)
  const configPath = join(testDir, 'ai.config.json')
  if (existsSync(configPath)) unlinkSync(configPath)
  initAiRuntime(pluginSystem, testDir)
})

async function createDoc(title = '测试文档'): Promise<string> {
  const res = await app.request('/docs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, markdown: '## 章节\n\n正文', notebook_id: notebookId }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

describe('文档级生命周期钩子', () => {
  test('创建文档触发 afterCreate（payload.doc 为文档根，meta 含 status/tags）', async () => {
    tapAll()
    try {
      const docId = await createDoc('标题')
      const ev = events.find((e) => e.hook === 'afterCreate')
      expect(ev).toBeDefined()
      expect(ev!.payload.doc.type).toBe('document')
      expect(ev!.payload.doc.id).toBe(docId)
      expect(ev!.payload.doc.content).toBe('标题')
      expect(ev!.payload.meta?.status).toBe('note')
    } finally {
      untapAll()
    }
  })

  test('归档触发 afterStatusChange（before.status 为旧状态，meta.status 为新状态）', async () => {
    tapAll()
    try {
      const docId = await createDoc()
      events.length = 0
      const res = await app.request(`/docs/${docId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      })
      expect(res.status).toBe(200)
      const ev = events.find((e) => e.hook === 'afterStatusChange')
      expect(ev).toBeDefined()
      expect(ev!.payload.before?.status).toBe('note')
      expect(ev!.payload.meta?.status).toBe('archived')
    } finally {
      untapAll()
    }
  })

  test('打标签触发 afterTagChange（meta 含 added/removed 集合）', async () => {
    tapAll()
    try {
      const docId = await createDoc()
      events.length = 0
      const res = await app.request(`/docs/${docId}/tags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: ['react', 'hooks'] }),
      })
      expect(res.status).toBe(200)
      const ev = events.find((e) => e.hook === 'afterTagChange')
      expect(ev).toBeDefined()
      const added = ev!.payload.meta?.added as string[] | undefined
      expect(added).toBeDefined()
      expect([...(added ?? [])].sort()).toEqual(['hooks', 'react'])
      expect(ev!.payload.before?.tags).toEqual([])
    } finally {
      untapAll()
    }
  })

  test('开启/关闭分享触发 afterShare 与 afterShareRevoked（meta 含 token）', async () => {
    tapAll()
    try {
      const docId = await createDoc()
      events.length = 0
      const put = await app.request(`/docs/${docId}/share`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(put.status).toBe(200)
      const shareEv = events.find((e) => e.hook === 'afterShare')
      expect(shareEv).toBeDefined()
      expect(shareEv!.payload.meta?.token).toBeTruthy()

      const del = await app.request(`/docs/${docId}/share`, { method: 'DELETE' })
      expect(del.status).toBe(200)
      const revokeEv = events.find((e) => e.hook === 'afterShareRevoked')
      expect(revokeEv).toBeDefined()
      expect(revokeEv!.payload.meta?.token).toBeTruthy()
    } finally {
      untapAll()
    }
  })

  test('删除文档触发 afterDelete', async () => {
    tapAll()
    try {
      const docId = await createDoc()
      events.length = 0
      const res = await app.request(`/docs/${docId}`, { method: 'DELETE' })
      expect(res.status).toBe(200)
      const ev = events.find((e) => e.hook === 'afterDelete')
      expect(ev).toBeDefined()
      expect(ev!.payload.doc.id).toBe(docId)
    } finally {
      untapAll()
    }
  })

  test('导入触发 afterCreate（meta.source = import）', async () => {
    tapAll()
    try {
      const res = await app.request('/import/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '导入的文档', markdown: '正文', notebook_id: notebookId }),
      })
      expect(res.status).toBe(201)
      const ev = events.find((e) => e.hook === 'afterCreate')
      expect(ev).toBeDefined()
      expect(ev!.payload.meta?.source).toBe('import')
    } finally {
      untapAll()
    }
  })
})
