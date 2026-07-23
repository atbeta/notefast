import { describe, expect, test } from 'bun:test'
import {
  docMatchesTags,
  normalizeTag,
  normalizeTagList,
  parseTagsQueryParam,
  parseTagMatchMode,
  parseUpdatedWithin,
  readAiExclude,
  readTags,
  writeTags,
} from '../tags'
import type { BlockRow } from '../types'

describe('normalizeTag', () => {
  test('小写、空格转连字符', () => {
    expect(normalizeTag('  Hello World  ')).toBe('hello-world')
  })

  test('空串无效', () => {
    expect(normalizeTag('   ')).toBeNull()
  })
})

describe('parseTagMatchMode', () => {
  test('默认 AND', () => {
    expect(parseTagMatchMode(undefined)).toBe('all')
    expect(parseTagMatchMode('')).toBe('all')
    expect(parseTagMatchMode('all')).toBe('all')
  })

  test('OR 别名', () => {
    expect(parseTagMatchMode('any')).toBe('any')
    expect(parseTagMatchMode('or')).toBe('any')
  })
})

describe('docMatchesTags', () => {
  test('any：命中任一即可', () => {
    expect(docMatchesTags(['work', 'ai'], ['ai'], 'any')).toBe(true)
    expect(docMatchesTags(['work'], ['ai', 'life'], 'any')).toBe(false)
  })

  test('all：必须全部包含', () => {
    expect(docMatchesTags(['work', 'ai'], ['work', 'ai'], 'all')).toBe(true)
    expect(docMatchesTags(['work'], ['work', 'ai'], 'all')).toBe(false)
  })

  test('selected 为空不过滤', () => {
    expect(docMatchesTags(['work'], [], 'any')).toBe(true)
  })
})

describe('parseTagsQueryParam', () => {
  test('合并 tags 与 tag，去重排序', () => {
    expect(parseTagsQueryParam('Work, AI', 'life')).toEqual(['ai', 'life', 'work'])
  })

  test('兼容仅 tag', () => {
    expect(parseTagsQueryParam(undefined, 'Foo')).toEqual(['foo'])
  })
})

describe('parseUpdatedWithin', () => {
  test('支持 24h / 7d', () => {
    expect(parseUpdatedWithin('24h')).toBe(24 * 60 * 60 * 1000)
    expect(parseUpdatedWithin('7d')).toBe(7 * 24 * 60 * 60 * 1000)
    expect(parseUpdatedWithin('1h')).toBeNull()
  })
})

describe('ai_exclude 显式列', () => {
  test('读写 ai_exclude 列', () => {
    const row: BlockRow = {
      id: 'x', notebook_id: 'nb1', parent_id: null, root_id: 'x',
      type: 'document', content: '', properties: '{}',
      tags: '[]', status: 'note', ai_exclude: 0,
      sort: 0, level: 0, created_at: '', updated_at: '',
    }
    expect(readAiExclude(row)).toBe(false)
    const excluded: BlockRow = { ...row, ai_exclude: 1 }
    expect(readAiExclude(excluded)).toBe(true)
  })

  test('readTags 读 tags 列', () => {
    const row: BlockRow = {
      id: 'x', notebook_id: 'nb1', parent_id: null, root_id: 'x',
      type: 'document', content: '', properties: '{}',
      tags: '["x","y"]', status: 'note', ai_exclude: 0,
      sort: 0, level: 0, created_at: '', updated_at: '',
    }
    expect(readTags(row)).toEqual(['x', 'y'])
  })

  test('writeTags 序列化', () => {
    expect(writeTags(['B', 'a'])).toBe('["a","b"]')
    expect(writeTags([])).toBe('[]')
  })
})

describe('normalizeTagList', () => {
  test('去重排序', () => {
    expect(normalizeTagList(['B', 'a', 'B'])).toEqual(['a', 'b'])
  })
})
