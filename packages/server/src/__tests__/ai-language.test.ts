import { describe, expect, test } from 'bun:test'
import { resolveAiLang } from '../ai/locale'
import { buildChatPrompt } from '../ai/prompt'
import { listSkills } from '../ai/skills'
import { suggestTitle, messageText } from '@notefast/core'
import type { LLMProvider } from '@notefast/core'

describe('AI 语言跟随 UI', () => {
  test('resolveAiLang 解析 Accept-Language', () => {
    expect(resolveAiLang('en-US,en;q=0.9,zh-CN;q=0.8')).toBe('en')
    expect(resolveAiLang('en')).toBe('en')
    expect(resolveAiLang('zh-CN')).toBe('zh')
    expect(resolveAiLang(undefined)).toBe('zh')
    expect(resolveAiLang('')).toBe('zh')
  })

  test('buildChatPrompt lang=en 生成英文系统提示与工具描述', () => {
    const zh = buildChatPrompt({ messages: [{ role: 'user', content: 'hi' }], citations: [], lang: 'zh' })
    const en = buildChatPrompt({ messages: [{ role: 'user', content: 'hi' }], citations: [], lang: 'en' })
    expect(zh[0]!.content).toContain('你是 NoteFast 的 AI 助手')
    expect(en[0]!.content).toContain("You are NoteFast's AI assistant")
    expect(en[0]!.content).not.toContain('你是')
  })

  test('listSkills lang=en 返回英文名称', () => {
    expect(listSkills('en')[0]!.name).toBe('Triage inbox')
    expect(listSkills('zh')[0]!.name).toBe('整理收集箱')
    expect(listSkills('en')[0]!.prompt).toContain('{{today}}'.replace('{{today}}', '')) // prompt 已插值 today
    expect(listSkills('en')[0]!.prompt).not.toContain('{{today}}')
  })

  test('suggestTitle lang=en 用英文系统提示', async () => {
    let seen: string | null = null
    const provider: LLMProvider = {
      name: 'mock',
      chat: async (msgs) => {
        seen = messageText(msgs[0]!.content)
        return '{"title":"Hi","summary":"A note"}'
      },
    }
    await suggestTitle(provider, 'hello world note content', 'en')
    expect(seen).not.toBeNull()
    expect(seen!).toContain("You are NoteFast's AI assistant")
    expect(seen!).not.toContain('你是')
  })
})

describe('检索结果注入 prompt 携带 ID', () => {
  // read_doc / update_block 的指引是「ID 从检索结果获取」——citations 渲染必须带 doc_id/block_id，
  // 否则模型只能报「检索结果中没有 doc_id」（用户实测踩坑）
  test('citations 渲染含 doc_id 与 block_id（zh/en 均带）', async () => {
    const { buildChatPrompt } = await import('../ai/prompt')
    const citation = {
      block_id: 'b-123',
      doc_id: 'd-456',
      doc_title: '配置指南',
      type: 'paragraph',
      content: '正文片段',
      snippet: '正文片段',
      score: 0.9,
      rrf_score: 0.05,
    }
    for (const lang of ['zh', 'en'] as const) {
      const msgs = buildChatPrompt({
        messages: [{ role: 'user', content: '怎么配置' }],
        citations: [citation],
        lang,
      })
      const sys = String(msgs[0]?.content ?? '')
      expect(sys).toContain('doc_id: d-456')
      expect(sys).toContain('block_id: b-123')
    }
  })
})
