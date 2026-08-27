import { describe, expect, test } from 'bun:test'
import { formatAskAiDraft } from '../askAi'

describe('formatAskAiDraft', () => {
  test('前缀在首行；引用变引用块', () => {
    expect(formatAskAiDraft('关于这段内容：', 'hello')).toBe(
      '关于这段内容：\n> hello\n\n',
    )
  })

  test('有 blockId 行插在前缀与引用之间', () => {
    expect(formatAskAiDraft('关于这段内容：', 'a\nb', '目标 block_id: x-1')).toBe(
      '关于这段内容：\n目标 block_id: x-1\n> a\n> b\n\n',
    )
  })
})
