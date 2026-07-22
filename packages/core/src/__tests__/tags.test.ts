import { describe, expect, test } from 'bun:test'
import {
  docMatchesTags,
  normalizeTag,
  normalizeTagList,
  parseTagsQueryParam,
  parseTagMatchMode,
  parseUpdatedWithin,
  readAiExcludeFromProperties,
  readTagsFromProperties,
  setAiExcludeInProperties,
} from '../tags'

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

describe('ai_exclude properties', () => {
  test('读写 ai_exclude', () => {
    expect(readAiExcludeFromProperties('{}')).toBe(false)
    const on = setAiExcludeInProperties('{"tags":["a"]}', true)
    expect(JSON.parse(on)).toEqual({ tags: ['a'], ai_exclude: true })
    expect(readAiExcludeFromProperties(on)).toBe(true)
    const off = setAiExcludeInProperties(on, false)
    expect(JSON.parse(off)).toEqual({ tags: ['a'] })
  })

  test('readTags 不受 ai_exclude 影响', () => {
    expect(readTagsFromProperties('{"tags":["x"],"ai_exclude":true}')).toEqual(['x'])
  })
})

describe('normalizeTagList', () => {
  test('去重排序', () => {
    expect(normalizeTagList(['B', 'a', 'B'])).toEqual(['a', 'b'])
  })
})
