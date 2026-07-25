/**
 * AI 写作辅助 prompt 模板
 *
 * 每个 mode 返回 system + user 两个 message，由调用方注入 LLM。
 * 设计原则：指令精简、避免模型过度发散、不重复上文、直接输出正文。
 */

import type { ChatMessage } from '../llm'

export type WriteMode = 'continue' | 'refine' | 'translate' | 'summarize' | 'expand' | 'shorten'

export interface WritePrompt {
  system: string
  user: string
}

const SYSTEM_CONTINUE = `你是 NoteFast 写作助手。从用户给出的上文自然续写，保持相同的语气、风格、知识水平和语言。
不要重复上文。不要问候语、不要"好的"之类的确认词。不要总结。不要另起话题。
直接写出正文，就像你正在同一个人写同一篇文章。`

const SYSTEM_REFINE = `你是 NoteFast 写作助手。{instruction}原文，保持相同风格和核心意思。
只输出改写后的文本。不要解释改了什么。不要加前缀或后缀。`

const SYSTEM_TRANSLATE = `你是 NoteFast 翻译助手。把原文翻译成{target}。
只输出译文。不要解释。不要保留原文。不要加前缀或后缀。`

const SYSTEM_SUMMARIZE = `你是 NoteFast 写作助手。提取原文核心观点，用精简的语言总结。
只输出总结文本。不要"本文讨论了"之类的元描述。不要加前缀或后缀。`

const SYSTEM_EXPAND = `你是 NoteFast 写作助手。扩写原文，添加更多细节、例子或解释。
保持原文风格和核心意思不变。只输出扩写后的文本。不要加前缀或后缀。`

const SYSTEM_SHORTEN = `你是 NoteFast 写作助手。压缩原文，保留核心信息，删除冗余。
保持原文风格和关键意思。只输出压缩后的文本。不要加前缀或后缀。`

export function buildWritePrompt(
  mode: WriteMode,
  content: string,
  opts?: {
    instruction?: string
    targetLang?: string
  },
): ChatMessage[] {
  switch (mode) {
    case 'continue':
      return [
        { role: 'system', content: SYSTEM_CONTINUE },
        { role: 'user', content: `上文：\n${content}\n\n请从当前位置自然续写：` },
      ]

    case 'refine':
      return [
        { role: 'system', content: SYSTEM_REFINE.replace('{instruction}', opts?.instruction || '润色') },
        { role: 'user', content: `原文：\n${content}\n\n改写：` },
      ]

    case 'translate':
      return [
        { role: 'system', content: SYSTEM_TRANSLATE.replace('{target}', opts?.targetLang || '中文') },
        { role: 'user', content: `原文：\n${content}\n\n译文：` },
      ]

    case 'summarize':
      return [
        { role: 'system', content: SYSTEM_SUMMARIZE },
        { role: 'user', content: `原文：\n${content}\n\n总结：` },
      ]

    case 'expand':
      return [
        { role: 'system', content: SYSTEM_EXPAND },
        { role: 'user', content: `原文：\n${content}\n\n扩写：` },
      ]

    case 'shorten':
      return [
        { role: 'system', content: SYSTEM_SHORTEN },
        { role: 'user', content: `原文：\n${content}\n\n压缩：` },
      ]
  }
}
