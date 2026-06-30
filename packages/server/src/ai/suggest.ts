/**
 * 标题与摘要自动生成
 *
 * 轻量 AI 介入：输入一段 Markdown 正文，输出一个短标题和一句话摘要。
 * 不存储任何额外数据，纯函数式调用。
 */

import type { LLMProvider } from '@notefast/core'

export interface TitleSuggestion {
  title: string
  summary: string
}

const SYSTEM_PROMPT = `你是 NoteFast 的 AI 助手。你的任务是为笔记内容生成简洁的标题和一句话摘要。

规则：
1. 标题 5-15 字，抓住核心主题
2. 摘要一句话，不超过 30 字
3. 如果内容很短（<10 字），标题就是内容本身
4. 不要加引号、不要序号、不要"标题："等前缀
5. 返回纯文本，格式：标题\n摘要`

export async function suggestTitle(
  provider: LLMProvider,
  content: string,
): Promise<TitleSuggestion> {
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: content.slice(0, 3000) },
  ]

  const result = await provider.chat(messages, {
    temperature: 0.3,
    maxTokens: 100,
  })

  const lines = result.trim().split('\n').map((l) => l.trim()).filter(Boolean)
  const title = lines[0]?.slice(0, 50) || content.slice(0, 20)
  const summary = lines[1]?.slice(0, 80) || ''

  return { title, summary }
}
