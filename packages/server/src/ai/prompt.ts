/**
 * Chat Prompt 模板
 *
 * 设计原则：
 * - 系统提示明确身份（"NoteFast 知识库助手"）和引用规则（在答案正文中用 [n] 标注来源编号）
 * - 上下文区用清晰的 XML 风格分隔，便于小型模型也能解析
 * - 多轮对话历史压缩策略：保留最近 N 轮；超出后只留 system + user 当前问题
 * - tool 定义：在 system prompt 末尾追加「可用工具」段；实际 tool_calls 由 chat 层注入 messages（OpenAI 协议）
 */

import type { ChatMessage, ToolDefinition } from '@notefast/core'
import type { Citation } from './hybridSearch'

export interface ChatPromptInput {
  /** 完整对话历史（已包含当前用户消息） */
  messages: ChatMessage[]
  /** 检索召回的 blocks，按最终排序传入 */
  citations: Citation[]
  /** 当前查看的文档标题 */
  currentDocTitle?: string
  /** 当前查看文档的完整 Markdown 内容（有 contextDocId 时自动加载） */
  currentDocContent?: string
  /** 历史压缩阈值 */
  maxHistoryTurns?: number
  /** 可用工具定义；为空时不在 system prompt 描述工具能力 */
  tools?: ToolDefinition[]
}

const SYSTEM_PROMPT = `你是 NoteFast 的 AI 助手，正在与用户讨论他的个人知识库。

规则：
1. 回答必须严格基于下方"检索到的笔记"。严禁凭空编造任何信息、文档标题、内容或事实。如果笔记中没有任何相关内容，请直接说明"我的笔记里没有找到相关内容"，不要尝试推测或补全。
2. 在引用任何具体内容时，用 [1]、[2] 这种方括号编号标注来源，对应下方"检索到的笔记"的序号。
3. 回答简洁直接，避免套话和重复问题。如果你不确定，就说不确定——不要为了凑字数而编造。
4. 如果用户问的是方法/步骤，优先引用相关笔记而不是泛泛而谈。没有检索到相关内容时，不要提供"常见做法"或"通用建议"，直接说明未找到。
5. 用户当前正在查看的文档（如有）具有更高优先级——可以引用但不要假设用户只关心这一个文档。
6. 若初始检索结果不充分、用户问得更具体、或需要时间维度（"上周写过什么"），调用 notefast_search_more 重新检索，不要硬猜。
7. 用户要求"记下来""保存""新建笔记""创建文档"时，调用 notefast_create_note 写入新笔记。创建后简要告知用户已保存，并提供 doc_id。
8. 用户要求"加到 XX 笔记里""补充到 XX 文档""追加"时，调用 notefast_append_to_doc。需要准确的 doc_id（从检索结果中的 block.doc_id 获取）。操作完成后告知用户是否成功。
9. 写操作前先确认：如果用户提到的是模糊名称而非具体 doc_id，先检索找到目标文档再写。不要猜测 doc_id。
10. 如果用户的问题在你的知识库笔记中找不到答案（如问外部新闻、最新资讯、技术动态），且 notefast_web_search 可用，调用它搜索互联网补充信息。来自网络的搜索结果用 🌐 标注来源 URL，与笔记引用 [n] 区分开。
11. 检索结果只是 block 级片段，不是完整文档。当用户问的是某篇文章的整体内容（"那篇文章具体说了什么""总结一下这篇"）或片段不足以回答时，调用 notefast_read_doc 拉取整篇 Markdown，不要仅凭片段猜测全文。`

export function buildChatPrompt(input: ChatPromptInput): ChatMessage[] {
  const { messages, citations, currentDocTitle, currentDocContent, tools } = input
  const maxTurns = input.maxHistoryTurns ?? 6

  const systemContent = citations.length > 0
    ? `${SYSTEM_PROMPT}\n\n${buildContextBlock(citations, currentDocTitle, currentDocContent)}`
    : `${SYSTEM_PROMPT}\n\n${buildContextBlock([], currentDocTitle, currentDocContent)}`

  let withTools = systemContent
  if (tools && tools.length > 0) {
    withTools += `\n\n${buildToolsBlock(tools)}`
  }

  const history = compressHistory(messages, maxTurns)

  return [{ role: 'system', content: withTools }, ...history]
}

function buildContextBlock(citations: Citation[], currentDocTitle?: string, currentDocContent?: string): string {
  let docBlock = ''
  if (currentDocTitle || currentDocContent) {
    docBlock = currentDocTitle ? `用户当前查看文档：《${currentDocTitle}》\n` : '用户当前正在浏览一篇文档\n'
    if (currentDocContent) {
      // 截断过长内容，为检索结果留空间
      const maxLen = 4000
      const truncated = currentDocContent.length > maxLen
        ? currentDocContent.slice(0, maxLen) + '\n\n... (文档过长，已截断。可使用 notefast_read_doc 读取全文)'
        : currentDocContent
      docBlock += `\n完整内容：\n---\n${truncated}\n---\n\n`
    } else {
      docBlock += '\n'
    }
  }
  if (citations.length === 0) {
    return `${docBlock}(本次未检索到相关笔记。请直接告知用户未找到相关内容，不要编造或猜测。若用户的问题涉及"有哪些""列出所有"等列表性查询，建议调用 notefast_list_docs 获取文档列表。)`
  }
  const items = citations
    .map((c, i) => {
      const head = `[${i + 1}] 文档《${c.doc_title}》 · ${c.type}`
      const body = c.content
      const tail = c.type === 'code' ? '\n```' : ''
      const prefix = c.type === 'code' ? '```\n' : ''
      return `${head}\n${prefix}${body}${tail}`
    })
    .join('\n\n')
  return `${docBlock}检索到的笔记（共 ${citations.length} 条）：\n\n${items}`
}

function buildToolsBlock(tools: ToolDefinition[]): string {
  const lines = tools.map((t) => {
    const params = JSON.stringify(t.function.parameters, null, 2)
    return `- **${t.function.name}**: ${t.function.description}\n  参数:\n  \`\`\`json\n  ${params}\n  \`\`\``
  })
  return `可用工具（必要时调用；最多连续 3 轮）：\n\n${lines.join('\n\n')}\n\n调用方式：返回 tool_calls 字段，参数用 JSON 对象。每次只调 1~2 个工具，避免噪音。写工具执行后不需要二次确认。`
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
