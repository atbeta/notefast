/**
 * CJK bigram 抽取：只切连续汉字滑动 2-gram，ASCII / 标点断开。
 * 检索侧用这些 gram 做候选预过滤，精确子串仍走 LIKE。
 */
import { describe, test, expect } from 'bun:test'
import { extractCjkBigrams, cjkNgramPrefilter } from '../cjkNgrams'

describe('extractCjkBigrams', () => {
  test('2 字词产出恰好 1 个 gram（trigram 死区由 bigram 覆盖）', () => {
    expect(extractCjkBigrams('笔记')).toEqual(['笔记'])
  })

  test('连续汉字按滑动窗口切 bigram', () => {
    expect(extractCjkBigrams('向量数据库')).toEqual(['向量', '量数', '数据', '据库'])
  })

  test('ASCII / 空格 / 标点断开，不跨段成 gram', () => {
    expect(extractCjkBigrams('向量 sqlite 数据库')).toEqual(['向量', '数据', '据库'])
  })

  test('单字汉字不进索引', () => {
    expect(extractCjkBigrams('选 A 库')).toEqual([])
  })

  test('去重：同一 gram 在块内只保留一次', () => {
    expect(extractCjkBigrams('笔记笔记')).toEqual(['笔记', '记笔'])
  })
})

describe('cjkNgramPrefilter', () => {
  test('纯 CJK 组：AND 用 EXISTS 约束每个 bigram', () => {
    const pre = cjkNgramPrefilter([['向量数据库']], false)
    expect(pre).not.toBeNull()
    expect(pre!.params).toEqual(['向量', '量数', '数据', '据库'])
    expect(pre!.sql).toContain('EXISTS')
    expect((pre!.sql.match(/AND g\.gram/g) ?? []).length).toBe(4)
  })

  test('AND 混合查询：只预过滤 CJK 组，ASCII 留给 LIKE', () => {
    const pre = cjkNgramPrefilter([['sqlite'], ['向量']], false)
    expect(pre).not.toBeNull()
    expect(pre!.params).toEqual(['向量'])
    expect(pre!.sql).toContain('EXISTS')
  })

  test('OR 含 ASCII 组则放弃预过滤（避免漏召回）', () => {
    expect(cjkNgramPrefilter([['sqlite'], ['向量']], true)).toBeNull()
  })

  test('全 ASCII 不预过滤', () => {
    expect(cjkNgramPrefilter([['Tauri'], ['close']], false)).toBeNull()
  })
})
