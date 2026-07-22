import { describe, test, expect } from 'bun:test'
import { splitThinkContent, ThinkStreamParser } from '../ai/thinkSplit'

describe('splitThinkContent', () => {
  test('无标签原样返回', () => {
    expect(splitThinkContent('hello')).toEqual({ reasoning: '', content: 'hello' })
  })

  test('拆分完整 think 块', () => {
    const r = splitThinkContent('<think>why</think>\n\nanswer')
    expect(r.reasoning).toBe('why')
    expect(r.content).toBe('answer')
  })

  test('未闭合视为思考', () => {
    const r = splitThinkContent('pre <think>still thinking')
    expect(r.reasoning).toBe('still thinking')
    expect(r.content).toBe('pre')
  })
})

describe('ThinkStreamParser', () => {
  test('跨 chunk 拆分', () => {
    const p = new ThinkStreamParser()
    const a = p.push('<thi')
    expect(a).toEqual({ reasoning: '', content: '' })
    const b = p.push('nk>abc')
    expect(b.reasoning).toBe('abc')
    expect(b.content).toBe('')
    const c = p.push('</think>\nOK')
    expect(c.reasoning).toBe('')
    expect(c.content).toBe('\nOK')
    expect(p.flush()).toEqual({ reasoning: '', content: '' })
  })

  test('无 think 时直通 content', () => {
    const p = new ThinkStreamParser()
    expect(p.push('Hello ')).toEqual({ reasoning: '', content: 'Hello ' })
    expect(p.push('world')).toEqual({ reasoning: '', content: 'world' })
  })
})
