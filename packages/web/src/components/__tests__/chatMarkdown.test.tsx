/**
 * ChatMarkdown breaks prop — 软换行渲染契约
 *
 * breaks=true（分享页）：单个 \n 渲染为 <br>，与阅读态 BlockRenderer 对齐；
 * breaks=false（AI 聊天气泡，默认）：严格 CommonMark，段内 \n 折叠为空格。
 * 用 react-dom/server 渲染（无 DOM 依赖）。
 */
import { describe, test, expect } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ChatMarkdown from '../ChatMarkdown'

describe('ChatMarkdown breaks', () => {
  test('breaks=true：段内单换行渲染为 <br>', () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { content: '第一行\n第二行', breaks: true }))
    expect(html).toContain('<br')
  })

  test('breaks=false（默认）：段内单换行折叠，不出 <br>', () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { content: '第一行\n第二行' }))
    expect(html).not.toContain('<br')
  })

  test('空行分段在两种模式下都成立', () => {
    const md = '甲\n\n乙'
    for (const breaks of [true, false]) {
      const html = renderToStaticMarkup(createElement(ChatMarkdown, { content: md, breaks }))
      expect((html.match(/<p[ >]/g) ?? []).length).toBe(2)
    }
  })
})
