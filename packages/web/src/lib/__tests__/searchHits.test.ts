import { describe, expect, test } from 'bun:test'
import type { Block, SearchResult } from '@notefast/core'
import { collapseSearchHitsByDoc, highlightSegments, paletteDocTitle, searchHitDocPath, parseDocScrollHash } from '../searchHits'

function hit(partial: { id: string; root_id: string; content: string; snippet: string; doc_title?: string; rank?: number }): SearchResult {
  const block = {
    id: partial.id,
    root_id: partial.root_id,
    content: partial.content,
  } as Block
  return {
    block,
    rank: partial.rank ?? 1,
    snippet: partial.snippet,
    doc_title: partial.doc_title,
  }
}

describe('collapseSearchHitsByDoc', () => {
  test('同一文档多 block 只留相关度最高的一条', () => {
    const hits = [
      hit({ id: 'p1', root_id: 'doc-a', content: '第一段 关键词', snippet: '第一段 关键词' }),
      hit({ id: 'p2', root_id: 'doc-a', content: '第二段 关键词', snippet: '第二段 关键词' }),
      hit({ id: 'p3', root_id: 'doc-b', content: '另一篇 关键词', snippet: '另一篇 关键词' }),
    ]
    const out = collapseSearchHitsByDoc(hits, 8)
    expect(out.map((h) => h.block.root_id)).toEqual(['doc-a', 'doc-b'])
    expect(out[0]!.block.id).toBe('p1')
  })

  test('截断到 limit 篇文档而不是 limit 个 block', () => {
    const hits = [
      hit({ id: 'a1', root_id: 'a', content: 'x', snippet: 'x' }),
      hit({ id: 'a2', root_id: 'a', content: 'y', snippet: 'y' }),
      hit({ id: 'b1', root_id: 'b', content: 'z', snippet: 'z' }),
    ]
    expect(collapseSearchHitsByDoc(hits, 1)).toHaveLength(1)
    expect(collapseSearchHitsByDoc(hits, 1)[0]!.block.root_id).toBe('a')
  })
})

describe('paletteDocTitle', () => {
  test('优先用 API 下发的文档标题，不用子块正文', () => {
    const h = hit({
      id: 'p1',
      root_id: 'doc-a',
      content: '正文里的关键词',
      snippet: '正文里的关键词',
      doc_title: '真正的标题',
    })
    expect(paletteDocTitle(h, '无标题')).toBe('真正的标题')
  })

  test('命中文档根块时用块内容当标题', () => {
    const h = hit({
      id: 'doc-a',
      root_id: 'doc-a',
      content: '根标题',
      snippet: '根标题',
    })
    expect(paletteDocTitle(h, '无标题')).toBe('根标题')
  })
})

describe('searchHitDocPath', () => {
  test('子块命中带 #block- 锚，标题命中只开篇', () => {
    expect(searchHitDocPath(hit({
      id: 'p1',
      root_id: 'doc-a',
      content: '正文',
      snippet: '正文',
    }))).toBe('/doc/doc-a#block-p1')
    expect(searchHitDocPath(hit({
      id: 'doc-a',
      root_id: 'doc-a',
      content: '标题',
      snippet: '标题',
    }))).toBe('/doc/doc-a')
  })

  test('文档根 root_id 为空时仍只开篇', () => {
    expect(searchHitDocPath(hit({
      id: 'doc-a',
      root_id: '',
      content: '标题',
      snippet: '标题',
    }))).toBe('/doc/doc-a')
  })
})

describe('highlightSegments', () => {
  test('大小写不敏感地切出命中段，保留原文大小写', () => {
    expect(highlightSegments('Hello World', 'world')).toEqual([
      { text: 'Hello ', hit: false },
      { text: 'World', hit: true },
    ])
  })

  test('多处命中全部标出', () => {
    expect(highlightSegments('abXabXab', 'ab')).toEqual([
      { text: 'ab', hit: true },
      { text: 'X', hit: false },
      { text: 'ab', hit: true },
      { text: 'X', hit: false },
      { text: 'ab', hit: true },
    ])
  })

  test('空查询或无命中时整段不标', () => {
    expect(highlightSegments('标题', '')).toEqual([{ text: '标题', hit: false }])
    expect(highlightSegments('标题', '  ')).toEqual([{ text: '标题', hit: false }])
    expect(highlightSegments('标题', '别的')).toEqual([{ text: '标题', hit: false }])
  })

  test('正则特殊字符按字面匹配，不当正则用', () => {
    expect(highlightSegments('a.b (c)', '.b')).toEqual([
      { text: 'a', hit: false },
      { text: '.b', hit: true },
      { text: ' (c)', hit: false },
    ])
    expect(highlightSegments('axb', 'a.b')).toEqual([{ text: 'axb', hit: false }])
  })

  test('拼接各段还原原文', () => {
    const text = 'NoteFast 知识库 noteFast'
    expect(highlightSegments(text, 'notefast').map((s) => s.text).join('')).toBe(text)
  })
})

describe('parseDocScrollHash', () => {
  test('空 hash 不定位', () => {
    expect(parseDocScrollHash('')).toBeNull()
    expect(parseDocScrollHash('#')).toBeNull()
  })

  test('#block-<id> 与 #<id> 都得到块 id', () => {
    expect(parseDocScrollHash('#block-p1')).toBe('p1')
    expect(parseDocScrollHash('block-p1')).toBe('p1')
    expect(parseDocScrollHash('#heading-a')).toBe('heading-a')
  })
})
