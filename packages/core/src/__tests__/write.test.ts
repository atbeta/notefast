import { describe, test, expect } from 'bun:test'
import {
  CONTINUE_PREFIX_MAX,
  CONTINUE_SUFFIX_MAX,
  buildWritePrompt,
  clipContinuePrefix,
  clipContinueSuffix,
} from '../ai/write'

describe('clipContinuePrefix / clipContinueSuffix', () => {
  test('短文本原样返回', () => {
    expect(clipContinuePrefix('abc')).toBe('abc')
    expect(clipContinueSuffix('xyz')).toBe('xyz')
  })

  test('超长上文只保留末尾', () => {
    const text = '头'.repeat(100) + '尾'.repeat(CONTINUE_PREFIX_MAX)
    const clipped = clipContinuePrefix(text)
    expect(clipped.length).toBe(CONTINUE_PREFIX_MAX)
    expect(clipped.endsWith('尾'.repeat(20))).toBe(true)
    expect(clipped.includes('头')).toBe(false)
  })

  test('超长下文只保留开头', () => {
    const text = '前'.repeat(CONTINUE_SUFFIX_MAX) + '后'.repeat(100)
    const clipped = clipContinueSuffix(text)
    expect(clipped.length).toBe(CONTINUE_SUFFIX_MAX)
    expect(clipped.startsWith('前'.repeat(20))).toBe(true)
    expect(clipped.includes('后')).toBe(false)
  })
})

describe('buildWritePrompt continue', () => {
  test('用光标前/后分段，不把整篇当「上文」', () => {
    const msgs = buildWritePrompt('continue', '光标前的句子', { suffix: '光标后的段落' })
    const user = msgs.find((m) => m.role === 'user')?.content ?? ''
    expect(user).toContain('光标前')
    expect(user).toContain('光标前的句子')
    expect(user).toContain('光标后')
    expect(user).toContain('光标后的段落')
    expect(user).not.toMatch(/^上文：/m)
  })

  test('文末续写标明没有下文', () => {
    const msgs = buildWritePrompt('continue', '写到这里')
    const user = msgs.find((m) => m.role === 'user')?.content ?? ''
    expect(user).toContain('写到这里')
    expect(user).toContain('文末')
  })

  test('系统提示要求短续写且不重复上下文', () => {
    const msgs = buildWritePrompt('continue', '前文')
    const system = msgs.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('不要重复')
    expect(system).toMatch(/几句|一小段|一两/)
  })
})
