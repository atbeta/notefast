/**
 * buildIndexedText 构建器单元测试
 *
 * 覆盖：标题/章节/标签组合、空段省略、章节深度上限、parent 链防循环、
 * 文档根块不重复标题、图片 caption 拼接。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { createPluginSystem } from '@notefast/core'
import {
  initAiRuntime,
  applyNewConfig,
  _setRuntimeForTests,
} from '../services/aiRuntime'
import { buildIndexedText } from '../ai/indexedText'
import { getBlockById } from '../store/blocks'

let testDir: string
let notebookId: string
let pluginSystem: ReturnType<typeof createPluginSystem>

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-indexedtext-'))
  notebookId = initDb(testDir).notebookId
  pluginSystem = createPluginSystem()
  initAiRuntime(pluginSystem, testDir)
})

afterAll(() => {
  _setRuntimeForTests(null)
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  getDb().query('DELETE FROM blocks').run()
  getDb().query('DELETE FROM asset_captions').run()
})

function insert(opts: {
  id: string
  parentId?: string | null
  rootId?: string
  type?: string
  content: string
  tags?: string
  level?: number
}) {
  const now = new Date().toISOString()
  getDb()
    .query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, tags, status, ai_exclude, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'note', 0, 0, ?, ?, ?)`,
    )
    .run(
      opts.id,
      notebookId,
      opts.parentId ?? null,
      opts.rootId ?? opts.id,
      opts.type ?? 'paragraph',
      opts.content,
      opts.tags ?? '[]',
      opts.level ?? 0,
      now,
      now,
    )
}

const textOf = (id: string) => buildIndexedText(getBlockById(getDb(), id)!)

describe('buildIndexedText', () => {
  test('标题 + 章节路径 + 标签 + 正文 全量组合', async () => {
    insert({ id: 'doc', type: 'document', content: '我的笔记', tags: '["dev","笔记"]' })
    insert({ id: 'h1', parentId: 'doc', rootId: 'doc', type: 'heading', content: '第一章', level: 1 })
    insert({ id: 'h2', parentId: 'h1', rootId: 'doc', type: 'heading', content: '小节', level: 2 })
    insert({ id: 'p', parentId: 'h2', rootId: 'doc', content: '  正文内容  ', level: 3 })

    expect(await textOf('p')).toBe('标题：我的笔记\n章节：第一章 / 小节\n标签：dev, 笔记\n\n正文内容')
  })

  test('空段整体省略：无标签、无 heading 时只剩标题与正文', async () => {
    insert({ id: 'doc', type: 'document', content: '仅标题' })
    insert({ id: 'p', parentId: 'doc', rootId: 'doc', content: '正文', level: 1 })

    expect(await textOf('p')).toBe('标题：仅标题\n\n正文')
  })

  test('文档根块：标题即正文，不重复进标题/章节段', async () => {
    insert({ id: 'doc', type: 'document', content: '文档标题', tags: '["t1"]' })

    expect(await textOf('doc')).toBe('标签：t1\n\n文档标题')
  })

  test('章节路径上溯深度上限为 6', async () => {
    insert({ id: 'doc', type: 'document', content: 'D' })
    // 8 层 heading 链：h1(root 侧) → h8（p 的父）
    let parent = 'doc'
    for (let i = 1; i <= 8; i++) {
      insert({ id: `h${i}`, parentId: parent, rootId: 'doc', type: 'heading', content: `H${i}`, level: i })
      parent = `h${i}`
    }
    insert({ id: 'p', parentId: 'h8', rootId: 'doc', content: '正文', level: 9 })

    const text = await textOf('p')
    // 最多收集 6 个 heading（h3..h8），h1/h2 超出深度被截断
    expect(text).toBe('标题：D\n章节：H3 / H4 / H5 / H6 / H7 / H8\n\n正文')
  })

  test('parent 链成环时不死循环', async () => {
    insert({ id: 'doc', type: 'document', content: 'D' })
    insert({ id: 'a', parentId: 'doc', rootId: 'doc', type: 'heading', content: 'A', level: 1 })
    insert({ id: 'b', parentId: 'a', rootId: 'doc', type: 'heading', content: 'B', level: 2 })
    // 人为成环：a.parent → b，b.parent → a
    getDb().query('UPDATE blocks SET parent_id = ? WHERE id = ?').run('b', 'a')
    insert({ id: 'p', parentId: 'a', rootId: 'doc', content: '正文', level: 3 })

    const text = await textOf('p')
    expect(text).toContain('正文')
    expect(text).toContain('标题：D')
  })

  test('正文为空时返回空串（不进索引）', async () => {
    insert({ id: 'doc', type: 'document', content: 'D' })
    insert({ id: 'p', parentId: 'doc', rootId: 'doc', content: '   ', level: 1 })

    expect(await textOf('p')).toBe('')
  })

  test('vision 开启且有缓存 caption 时追加图片描述', async () => {
    applyNewConfig(
      {
        version: 1,
        chat: {
          id: 'c1',
          label: 'C',
          preset: 'custom',
          baseUrl: 'http://mock/v1',
          apiKey: 'sk-test',
          embeddingModel: '',
          chatModel: 'vision-chat',
          timeoutMs: 5000,
          extraHeaders: {},
        },
        embedding: null,
        autoIndex: false,
        reranker: null,
        vision: { enabled: true },
      },
      pluginSystem,
    )
    const assetId = 'b'.repeat(64)
    getDb()
      .query('INSERT INTO asset_captions (id, caption, model, created_at) VALUES (?, ?, ?, ?)')
      .run(assetId, '缓存的图片描述', 'vision-chat', new Date().toISOString())

    insert({ id: 'doc', type: 'document', content: 'D' })
    insert({ id: 'p', parentId: 'doc', rootId: 'doc', content: `看图 ![x](asset:${assetId})`, level: 1 })

    const text = await textOf('p')
    expect(text).toContain('看图')
    expect(text).toContain('[图片描述] 缓存的图片描述')
  })

  test('vision 未开启时不拼 caption', async () => {
    // 显式覆盖磁盘配置（上个用例开启了 vision，applyNewConfig 会持久化）
    applyNewConfig(
      {
        version: 1,
        chat: null,
        embedding: null,
        autoIndex: false,
        reranker: null,
      },
      pluginSystem,
    )
    const assetId = 'c'.repeat(64)
    getDb()
      .query('INSERT INTO asset_captions (id, caption, model, created_at) VALUES (?, ?, ?, ?)')
      .run(assetId, '不应出现', 'vision-chat', new Date().toISOString())

    insert({ id: 'doc', type: 'document', content: 'D' })
    insert({ id: 'p', parentId: 'doc', rootId: 'doc', content: `看图 asset:${assetId}`, level: 1 })

    expect(await textOf('p')).not.toContain('[图片描述]')
  })
})
