import { describe, expect, test } from 'bun:test'
import type { Block, SearchResult } from '@notefast/core'
import { collapseSearchHitsByDoc, paletteDocTitle } from '../searchHits'

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
