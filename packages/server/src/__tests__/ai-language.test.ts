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
