import { describe, test, expect } from 'bun:test'
import { resolveMarkdownHref } from '../markdownHref'

describe('resolveMarkdownHref', () => {
  test('占位 url / 裸词不能当成相对路径', () => {
    expect(resolveMarkdownHref('url').kind).toBe('invalid')
    expect(resolveMarkdownHref('link').kind).toBe('invalid')
    expect(resolveMarkdownHref('https://').kind).toBe('invalid')
    expect(resolveMarkdownHref('').kind).toBe('invalid')
  })

  test('javascript / data 协议拒绝', () => {
    expect(resolveMarkdownHref('javascript:alert(1)').kind).toBe('invalid')
    expect(resolveMarkdownHref('data:text/html,x').kind).toBe('invalid')
  })

  test('http(s) 外链保留', () => {
    expect(resolveMarkdownHref('https://example.com/a')).toEqual({
      kind: 'external',
      href: 'https://example.com/a',
    })
    expect(resolveMarkdownHref('http://example.com').kind).toBe('external')
  })

  test('站内绝对路径与页内锚点可用', () => {
    expect(resolveMarkdownHref('/doc/abc-id')).toEqual({ kind: 'internal', href: '/doc/abc-id' })
    expect(resolveMarkdownHref('#heading')).toEqual({ kind: 'hash', href: '#heading' })
  })

  test('mailto / tel 可用', () => {
    expect(resolveMarkdownHref('mailto:a@b.com').kind).toBe('external')
    expect(resolveMarkdownHref('tel:+1234').kind).toBe('external')
  })

  test('像域名但没写协议的补 https', () => {
    const r = resolveMarkdownHref('example.com/x')
    expect(r).toEqual({ kind: 'external', href: 'https://example.com/x' })
  })

  test('像文件名的不补协议', () => {
    expect(resolveMarkdownHref('notes.md').kind).toBe('invalid')
  })
})
