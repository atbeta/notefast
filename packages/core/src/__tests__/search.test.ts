import { describe, test, expect } from 'bun:test'
import { buildFtsQuery, highlightSnippet } from '../search'

describe('buildFtsQuery', () => {
  test('单关键词查询', () => {
    const { query, limit } = buildFtsQuery('测试')
    expect(query).toBe('"测试"')
    expect(limit).toBe(20)
  })

  test('多关键词查询', () => {
    const { query } = buildFtsQuery('hello world')
    expect(query).toBe('"hello" AND "world"')
  })

  test('空字符串', () => {
    const { query } = buildFtsQuery('')
    expect(query).toBe('')
  })

  test('自定义 limit', () => {
    const { limit } = buildFtsQuery('test', 5)
    expect(limit).toBe(5)
  })
})

describe('highlightSnippet', () => {
  test('生成高亮片段', () => {
    const snippet = highlightSnippet('这是一段很长的测试内容需要被截断', '测试')
    expect(snippet).toContain('测试')
  })

  test('内容太短时不截断', () => {
    const snippet = highlightSnippet('短内容', '短')
    expect(snippet).toBe('短内容')
  })

  test('未匹配时返回开头片段', () => {
    const snippet = highlightSnippet('这是一段内容', '不存在')
    expect(snippet.length).toBeGreaterThan(0)
  })
})
