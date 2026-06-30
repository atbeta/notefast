import { describe, test, expect } from 'bun:test'
import { suggestTitle } from '../ai/suggest'
import type { LLMProvider, ChatMessage, ChatCompletionOptions } from '../llm'

function makeFakeProvider(reply: string, opts: { throwOnJson?: boolean } = {}): LLMProvider {
  let callIdx = 0
  return {
    name: 'fake',
    async chat(_messages: ChatMessage[], o?: ChatCompletionOptions): Promise<string> {
      callIdx++
      // 第一次：JSON 模式 → 如果 throwOnJson 则抛错，否则返回 reply
      if (o?.responseFormat?.type === 'json_object') {
        if (opts.throwOnJson) throw new Error('unsupported response_format')
        return reply
      }
      // 降级调用：返回纯文本
      return reply
    },
  }
}

describe('suggestTitle', () => {
  test('空内容直接返回空', async () => {
    const p = makeFakeProvider('{"title":"","summary":""}')
    expect(await suggestTitle(p, '')).toEqual({ title: '', summary: '' })
  })

  test('结构化输出成功时解析 JSON', async () => {
    const p = makeFakeProvider('{"title":"React 性能优化","summary":"汇总 memo 与 lazy 经验"}')
    const r = await suggestTitle(p, '一段很长的笔记内容……')
    expect(r.title).toBe('React 性能优化')
    expect(r.summary).toBe('汇总 memo 与 lazy 经验')
  })

  test('模型把 JSON 包在 ```json ``` 时也能解析', async () => {
    const p = makeFakeProvider('```json\n{"title":"笔记","summary":"摘要"}\n```')
    const r = await suggestTitle(p, '内容')
    expect(r.title).toBe('笔记')
    expect(r.summary).toBe('摘要')
  })

  test('JSON 解析失败时降级到两行文本', async () => {
    const p = makeFakeProvider('冒号开头不是 JSON', { throwOnJson: true })
    const r = await suggestTitle(p, '内容')
    // 第一次 JSON 抛错 → 降级调用同 reply，split('\n')
    expect(r.title).toBe('冒号开头不是 JSON')
    expect(r.summary).toBe('')
  })

  test('不支持 response_format 时降级', async () => {
    const p = makeFakeProvider('React Hooks 笔记\n关于 useState 与 useEffect', {
      throwOnJson: true,
    })
    const r = await suggestTitle(p, '内容')
    expect(r.title).toBe('React Hooks 笔记')
    expect(r.summary).toBe('关于 useState 与 useEffect')
  })

  test('title 超长会被截断到 50 字', async () => {
    const long = '一'.repeat(100)
    const p = makeFakeProvider(`{"title":"${long}","summary":""}`)
    const r = await suggestTitle(p, '内容')
    expect(r.title.length).toBeLessThanOrEqual(50)
  })
})