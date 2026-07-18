/**
 * Chat Prompt 模板
 *
 * 设计原则：
 * - 系统提示明确身份（"NoteFast 知识库助手"）和引用规则（在答案正文中用 [n] 标注来源编号）
 * - 上下文区用清晰的 XML 风格分隔，便于小型模型也能解析
 * - 多轮对话历史压缩策略：保留最近 N 轮；超出后只留 system + user 当前问题
 */

import type { ChatMessage } from '@notefast/core'
import type { Citation } from './hybridSearch'

export interface ChatPromptInput {
  /** 完整对话历史（已包含当前用户消息） */
  messages: ChatMessage[]
  /** 检索召回的 blocks，按最终排序传入 */
  citations: Citation[]
  /** 当前查看的文档 ID（可能为空）；用于提示模型"用户正在看 XX" */
  currentDocTitle?: string
  /** 历史压缩阈值 */
  maxHistoryTurns?: number
}

const SYSTEM_PROMPT = `你是 NoteFast 的 AI 助手，正在与用户讨论他的个人知识库。

规则：
1. 回答必须基于下方"检索到的笔记"。如果笔记中没有任何相关内容，请直接说明"我的笔记里没有找到相关内容"，不要凭空编造。
2. 在引用任何具体内容时，用 [1]、[2] 这种方括号编号标注来源，对应下方"检索到的笔记"的序号。
3. 回答简洁直接，避免套话和重复问题。
4. 如果用户问的是方法/步骤，优先引用相关笔记而不是泛泛而谈。
5. 用户当前正在查看的文档（如有）具有更高优先级——可以引用但不要假设用户只关心这一个文档。`

export function buildChatPrompt(input: ChatPromptInput): ChatMessage[] {
  const { messages, citations, currentDocTitle } = input
  const maxTurns = input.maxHistoryTurns ?? 6

  const systemContent = citations.length > 0
    ? `${SYSTEM_PROMPT}\n\n${buildContextBlock(citations, currentDocTitle)}`
    : `${SYSTEM_PROMPT}\n\n(本次未检索到相关笔记，请根据通用知识回答，并在不确定时坦诚说明。)`

  const history = compressHistory(messages, maxTurns)

  return [{ role: 'system', content: systemContent }, ...history]
}

function buildContextBlock(citations: Citation[], currentDocTitle?: string): string {
  const header = currentDocTitle
    ? `用户当前查看文档："${currentDocTitle}"\n\n`
    : ''
  const items = citations
    .map((c, i) => {
      const head = `[${i + 1}] 文档《${c.doc_title}》 · ${c.type}`
      const body = c.content
      const tail = c.type === 'code' ? '\n```' : ''
      const prefix = c.type === 'code' ? '```\n' : ''
      return `${head}\n${prefix}${body}${tail}`
    })
    .join('\n\n')
  return `${header}检索到的笔记（共 ${citations.length} 条）：\n\n${items}`
}

/**
 * 压缩历史：
 * - 总是保留最后一轮 user 消息（当前问题）
 * - 中间按 turn 计数（user+assistant 一对）裁剪，保留最近 maxTurns 对
 * - 如果原始 history 已经 < maxTurns 对，原样返回
 */
function compressHistory(messages: ChatMessage[], maxTurns: number): ChatMessage[] {
  if (messages.length <= maxTurns * 2 + 1) return messages.slice()
  // 简单策略：保留最后一个 user 消息 + 倒数 maxTurns 个 turn
  const tail = messages.slice(-(maxTurns * 2))
  // 确保 tail 起始是 user（必要时丢掉第一条非 user）
  if (tail.length > 0 && tail[0]!.role !== 'user') tail.shift()
  return tail
}

export function truncateAssistantText(text: string, max = 4000): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}
