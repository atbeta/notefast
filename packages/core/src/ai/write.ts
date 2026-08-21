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

/** 续写只送光标附近，避免整篇笔记把模型带跑 */
export const CONTINUE_PREFIX_MAX = 6000
export const CONTINUE_SUFFIX_MAX = 1500

export function clipContinuePrefix(text: string): string {
  if (text.length <= CONTINUE_PREFIX_MAX) return text
  return text.slice(-CONTINUE_PREFIX_MAX)
}

export function clipContinueSuffix(text: string): string {
  if (text.length <= CONTINUE_SUFFIX_MAX) return text
  return text.slice(0, CONTINUE_SUFFIX_MAX)
}

const SYSTEM_CONTINUE = `你是 NoteFast 写作助手。在光标处插入续写，像同一作者接着写同一篇。

规则：
- 只输出应插入光标处的正文，不要重复光标前或光标后已有的文字
- 若光标在句中，先把这句话写完，再最多续几句
- 不要新开标题或章节，除非上文刚写完一个标题行
- 不要问候、确认语、总结、解释你在做什么
- 篇幅克制：通常几句到一小段，不要写成长文
- 上文若未换行，输出也不要以空行开头`

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
    /** 光标后的正文；仅 continue 使用 */
    suffix?: string
  },
): ChatMessage[] {
  switch (mode) {
    case 'continue': {
      const suffix = opts?.suffix?.trim() ?? ''
      const user = suffix
        ? `光标前：\n${content}\n\n光标后：\n${suffix}\n\n只输出插入光标处的续写：`
        : `光标前：\n${content}\n\n（已是文末）只输出接着往下写的正文：`
      return [
        { role: 'system', content: SYSTEM_CONTINUE },
        { role: 'user', content: user },
      ]
    }

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
