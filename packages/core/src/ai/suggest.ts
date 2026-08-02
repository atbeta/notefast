/**
 * 标题与摘要生成
 *
 * 通过 chat completion 让模型返回结构化 JSON { title, summary }。
 * OpenAI 兼容服务支持 response_format: json_object，否则降级到 prompt + 正则解析。
 */

import type { ChatMessage, LLMProvider } from '../llm'

export interface TitleSuggestion {
  title: string
  summary: string
}

const SYSTEM_PROMPT_ZH = `你是 NoteFast 的 AI 助手。根据用户的笔记内容，生成简洁的标题和一句话摘要。

规则：
1. 标题 5-15 字，抓住核心主题
2. 摘要一句话，不超过 30 字
3. 内容过短时，标题就是内容本身
4. 不要加引号、不要序号、不要前缀
5. 必须返回合法 JSON：{"title": "...", "summary": "..."}`

const SYSTEM_PROMPT_EN = `You are NoteFast's AI assistant. Given the user's note content, generate a concise title and a one-line summary.

Rules:
1. Title of 5-15 characters, capturing the core topic
2. Summary is a single sentence of no more than 30 words
3. If the content is very short, the title is the content itself
4. No quotes, no numbering, no prefixes
5. Must return valid JSON: {"title": "...", "summary": "..."}`

const SYSTEM_PROMPT_FALLBACK_ZH = `你是 NoteFast 的 AI 助手。根据笔记内容生成标题和摘要。
返回两行：第一行标题（5-15 字），第二行一句话摘要（不超过 30 字）。`

const SYSTEM_PROMPT_FALLBACK_EN = `You are NoteFast's AI assistant. Generate a title and summary for the note content.
Return two lines: first the title (5-15 characters), then a one-line summary (no more than 30 words).`

export async function suggestTitle(
  provider: LLMProvider,
  content: string,
  lang: 'zh' | 'en' = 'zh',
): Promise<TitleSuggestion> {
  const trimmed = content.trim().slice(0, 3000)
  if (!trimmed) return { title: '', summary: '' }

  const zh = lang !== 'en'
  const messages: ChatMessage[] = [
    { role: 'system', content: zh ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN },
    { role: 'user', content: trimmed },
  ]

  // 优先尝试结构化输出（OpenAI / OpenRouter / DeepSeek 均支持）
  try {
    const raw = await provider.chat(messages, {
      temperature: 0.3,
      maxTokens: 200,
      responseFormat: { type: 'json_object' },
    })
    const parsed = parseJson(raw)
    if (parsed) return clamp(parsed, content)
  } catch {
    // 某些兼容服务不支持 response_format，降级到纯文本
  }

  // 降级方案
  const raw = await provider.chat(
    [
      { role: 'system', content: zh ? SYSTEM_PROMPT_FALLBACK_ZH : SYSTEM_PROMPT_FALLBACK_EN },
      { role: 'user', content: trimmed },
    ],
    { temperature: 0.3, maxTokens: 100 },
  )
  return parseTwoLines(raw, content)
}

function parseJson(raw: string): TitleSuggestion | null {
  // 模型有时会把 JSON 包在 ```json ... ``` 里
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  // 尝试整段解析
  try {
    const obj = JSON.parse(stripped)
    if (typeof obj.title === 'string') {
      return { title: obj.title.trim(), summary: String(obj.summary || '').trim() }
    }
  } catch {
    /* fall through */
  }

  // 尝试从文本中抽取第一个 { ... } 子串
  const match = stripped.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const obj = JSON.parse(match[0])
      if (typeof obj.title === 'string') {
        return { title: obj.title.trim(), summary: String(obj.summary || '').trim() }
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

function parseTwoLines(raw: string, fallback: string): TitleSuggestion {
  const lines = raw
    .trim()
    .split('\n')
    .map((l) => l.trim().replace(/^["「]?|["」]?$/g, ''))
    .filter(Boolean)
  return {
    title: (lines[0] || fallback).slice(0, 50),
    summary: (lines[1] || '').slice(0, 80),
  }
}

function clamp(s: TitleSuggestion, fallback: string): TitleSuggestion {
  return {
    title: s.title.slice(0, 50) || fallback.slice(0, 20),
    summary: s.summary.slice(0, 80),
  }
}