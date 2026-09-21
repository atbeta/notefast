import { describe, test, expect } from 'bun:test'
import {
  MAX_MATCHES,
  MAX_PATTERN,
  compileFind,
  countMatches,
  findMatchRanges,
  stepFindIndex,
} from '../docFind'

describe('findMatchRanges', () => {
  test('空查询无命中', () => {
    expect(findMatchRanges('hello world', '')).toEqual([])
    expect(findMatchRanges('hello world', '   ')).toEqual([])
  })

  test('大小写不敏感；命中不重叠（与高亮的区间语义一致）', () => {
    expect(findMatchRanges('Ababa', 'aba')).toEqual([{ start: 0, end: 3 }])
    expect(findMatchRanges('abab aba', 'aba')).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 8 },
    ])
  })

  test('中文子串', () => {
    expect(findMatchRanges('阅读这篇笔记', '这篇')).toEqual([{ start: 2, end: 4 }])
  })
})

describe('stepFindIndex', () => {
  test('无命中保持 -1', () => {
    expect(stepFindIndex(-1, 0, 1)).toBe(-1)
  })

  test('下一个循环', () => {
    expect(stepFindIndex(2, 3, 1)).toBe(0)
    expect(stepFindIndex(-1, 3, 1)).toBe(0)
  })

  test('上一个循环', () => {
    expect(stepFindIndex(0, 3, -1)).toBe(2)
    expect(stepFindIndex(-1, 3, -1)).toBe(2)
  })
})

describe('查找选项', () => {
  test('区分大小写', () => {
    expect(countMatches('Note note NOTE', 'note', { caseSensitive: true, wholeWord: false, regex: false })).toBe(1)
    expect(countMatches('Note note NOTE', 'note', { caseSensitive: false, wholeWord: false, regex: false })).toBe(3)
  })

  test('全词匹配只命整词（中文没有词边界，见文件头）', () => {
    const opts = { caseSensitive: false, wholeWord: true, regex: false }
    expect(countMatches('cat category cat', 'cat', opts)).toBe(2)
    expect(countMatches('cut the cat', 'cat', { ...opts, caseSensitive: true })).toBe(1)
  })

  test('正则模式按模式解释，字面量模式把元字符当普通字符', () => {
    const re = { caseSensitive: true, wholeWord: false, regex: true }
    const lit = { caseSensitive: true, wholeWord: false, regex: false }
    expect(countMatches('a1 b22 c333', '\\d+', re)).toBe(3)
    expect(countMatches('a.b a1b', 'a.b', lit)).toBe(1) // 点号是字面量
    expect(countMatches('a.b a1b', 'a.b', re)).toBe(2) // 点号是任意字符
  })

  test('字面量查询两端空白自动去掉；正则模式原样保留', () => {
    expect(countMatches('abc', '  abc  ', { caseSensitive: false, wholeWord: false, regex: false })).toBe(1)
    expect(countMatches('abc', '  abc  ', { caseSensitive: false, wholeWord: false, regex: true })).toBe(0)
  })

  test('无效正则与危险正则分别报错，且不回退成字符串搜', () => {
    const re = { caseSensitive: false, wholeWord: false, regex: true }
    expect(compileFind('a(', re)).toEqual({ ok: false, error: 'invalid-regex' })
    expect(compileFind('(a+)+$', re)).toEqual({ ok: false, error: 'risky-regex' })
    expect(compileFind('(\\d{1,3})+', re)).toEqual({ ok: false, error: 'risky-regex' })
    // 无效查询不给命中：不回退成字符串搜（否则用户以为正则生效了）
    expect(countMatches('a( b', 'a(', re)).toBe(0)
  })

  test('空查询与超长模式', () => {
    expect(compileFind('', { caseSensitive: false, wholeWord: false, regex: false })).toEqual({
      ok: false,
      error: 'empty',
    })
    const long = 'x'.repeat(MAX_PATTERN + 1)
    expect(compileFind(long, { caseSensitive: false, wholeWord: false, regex: false })).toEqual({
      ok: false,
      error: 'risky-regex',
    })
  })

  test('零宽命中不死循环，命中数有上限', () => {
    const re = { caseSensitive: false, wholeWord: false, regex: true }
    expect(countMatches('bbb', 'a*', re)).toBe(0)
    expect(countMatches('a'.repeat(MAX_MATCHES + 10), 'a', re)).toBe(MAX_MATCHES)
  })
})
