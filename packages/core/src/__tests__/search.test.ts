import { describe, test, expect } from 'bun:test'
import { buildFtsQuery, highlightSnippet, fullToHalfWidth, halfToFullPunct } from '../search'

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

describe('fullToHalfWidth / halfToFullPunct', () => {
  test('全角 ASCII 区转半角，中文不受影响', () => {
    expect(fullToHalfWidth('ＲＡＧ（检索）１２３')).toBe('RAG(检索)123')
    expect(fullToHalfWidth('全角空格　分隔')).toBe('全角空格 分隔')
    expect(fullToHalfWidth('中文原文')).toBe('中文原文')
  })

  test('标点/数字转全角，字母保持半角（中文文档惯例写法）', () => {
    expect(halfToFullPunct('RAG(检索) 123')).toBe('RAG（检索）　１２３')
    expect(halfToFullPunct('abc')).toBe('abc')
    expect(halfToFullPunct('纯中文。')).toBe('纯中文。')
  })

  test('两者配对覆盖混合形态', () => {
    const content = 'RAG（检索增强生成）架构' // 文档：字母半角 + 括号全角
    const query = 'RAG(检索增强生成)架构' // 查询：括号半角
    const half = fullToHalfWidth(query)
    expect(content.includes(half)).toBe(false)
    expect(content.includes(halfToFullPunct(half))).toBe(true)
  })
})
