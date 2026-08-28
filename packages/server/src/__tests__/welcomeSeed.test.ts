/**
 * 新库种一篇「开始使用」笔记：只在空白新库写入一次，删光文档也不会再种。
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readTags } from '@notefast/core'
import { initDb, closeDb, getDb } from '../db'
import { countDocRows, listDocRows } from '../store/blocks'
import {
  seedWelcomeDocIfNeeded,
  WELCOME_MARKDOWN,
} from '../services/welcomeSeed'

let testDir: string
let notebookId: string

beforeEach(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-welcome-'))
  notebookId = initDb(testDir).notebookId
})

afterEach(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('seedWelcomeDocIfNeeded', () => {
  test('新库写入一篇带 guide 标签的笔记', () => {
    const result = seedWelcomeDocIfNeeded(getDb(), notebookId, { isNewDb: true })
    expect(result.seeded).toBe(true)
    expect(countDocRows(getDb())).toBe(1)
    const docs = listDocRows(getDb(), { status: 'note' })
    expect(docs).toHaveLength(1)
    expect(docs[0]!.content).toBe('开始使用')
    expect(readTags(docs[0]!)).toEqual(['guide'])
    for (const heading of ['写与读', '用标签组织', '搜索', '配置 AI', '导入、备份、外部接入']) {
      expect(WELCOME_MARKDOWN).toContain(`## ${heading}`)
    }
    expect(WELCOME_MARKDOWN.length).toBeGreaterThan(800)
  })

  test('已有库不种', () => {
    expect(seedWelcomeDocIfNeeded(getDb(), notebookId, { isNewDb: false }).seeded).toBe(false)
    expect(countDocRows(getDb())).toBe(0)
  })

  test('新库已有文档时不重复种', () => {
    seedWelcomeDocIfNeeded(getDb(), notebookId, { isNewDb: true })
    expect(seedWelcomeDocIfNeeded(getDb(), notebookId, { isNewDb: true }).seeded).toBe(false)
    expect(countDocRows(getDb())).toBe(1)
  })
})
