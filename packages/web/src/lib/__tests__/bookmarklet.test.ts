import { describe, test, expect } from 'bun:test'
import { normalizeClipUrl, buildBookmarkletCode } from '../bookmarklet'

describe('normalizeClipUrl（采集 URL 规范化）', () => {
  test('去 hash', () => {
    expect(normalizeClipUrl('https://example.com/a#sec-1')).toBe('https://example.com/a')
  })

  test('去 utm_* 参数，保留其他参数', () => {
    expect(normalizeClipUrl('https://example.com/a?utm_source=x&id=1&utm_medium=y')).toBe('https://example.com/a?id=1')
  })

  test('utm 大小写不敏感', () => {
    expect(normalizeClipUrl('https://example.com/a?UTM_SOURCE=x')).toBe('https://example.com/a')
  })

  test('已规范的 URL 不变（去重幂等的前提）', () => {
    expect(normalizeClipUrl('https://example.com/a?id=1')).toBe('https://example.com/a?id=1')
  })

  test('非法 URL 原样返回', () => {
    expect(normalizeClipUrl('not a url')).toBe('not a url')
  })
})

describe('buildBookmarkletCode', () => {
  const code = buildBookmarkletCode({ endpoint: 'https://notes.example.com/', token: 'nf_test"token' })

  test('javascript: 单行形态', () => {
    expect(code.startsWith('javascript:(async()=>{')).toBe(true)
    expect(code.endsWith('})()')).toBe(true)
    expect(code).not.toContain('\n')
  })

  test('endpoint 去尾部斜杠后嵌入 API 路径', () => {
    expect(code).toContain('const E="https://notes.example.com"')
    expect(code).toContain("E+'/api/v1/import/markdown'")
  })

  test('token 经 JSON 转义嵌入（引号安全）', () => {
    expect(code).toContain(',T="nf_test\\"token"')
    expect(code).toContain("Authorization:'Bearer '+T")
  })

  test('source 契约为 web-clipper + 规范化 URL', () => {
    expect(code).toContain("provider:'web-clipper'")
    expect(code).toContain('external_id:u')
    expect(code).toContain('^utm_')
  })

  test('收集箱状态与正文模板', () => {
    expect(code).toContain("status:'inbox'")
    expect(code).toContain(String.raw`'\n\n'`)
  })

  test('alert 文案默认中文，可由 labels 覆盖', () => {
    expect(code).toContain('已收集到 NoteFast 收集箱')
    const en = buildBookmarkletCode({ endpoint: 'https://n.co', token: 't', labels: { success: 'Saved', failure: 'Failed' } })
    expect(en).toContain('"Saved"')
    expect(en).toContain('"Failed"')
  })
})
