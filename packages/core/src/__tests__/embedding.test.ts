import { describe, test, expect } from 'bun:test'
import { truncateText, cosineSimilarity } from '../embedding'

describe('truncateText', () => {
  test('纯中文长文超限 → 按字符截断', () => {
    const text = '汉'.repeat(20_000)
    const out = truncateText(text, 100)
    expect(out.length).toBe(100)
    expect(out).toBe('汉'.repeat(100))
  })

  test('英文长文超限 → 按词截断，不切断单词', () => {
    const words = Array.from({ length: 500 }, (_, i) => `word${i}`)
    const out = truncateText(words.join(' '), 100)
    expect(out.split(' ').length).toBe(100)
    expect(out.endsWith('word99')).toBe(true)
  })

  test('中英混合超限 → 被截断', () => {
    const text = 'hello ' + '中'.repeat(5_000) + ' world'
    const out = truncateText(text, 100)
    // "hello " + 100 个中文字符
    expect(out).toBe('hello ' + '中'.repeat(100))
    expect(out.length).toBeLessThanOrEqual(120)
  })

  test('短文本未超限 → 原样返回', () => {
    const text = 'short text 短文本'
    expect(truncateText(text, 100)).toBe(text)
  })

  test('中文短文本未超限 → 原样返回', () => {
    const text = '这是一段不太长的中文。'
    expect(truncateText(text, 100)).toBe(text)
  })

  test('空字符串原样返回', () => {
    expect(truncateText('', 100)).toBe('')
  })
})

describe('cosineSimilarity', () => {
  test('相同向量相似度为 1，正交向量为 0', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })

  test('零向量返回 0，支持 Float64Array', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0)
    expect(cosineSimilarity(new Float64Array([1, 1]), new Float64Array([1, 1]))).toBeCloseTo(1)
  })
})
