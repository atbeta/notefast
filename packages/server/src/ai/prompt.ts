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
import type { AiLang } from './locale'

/** 当前文档可写块（注入 prompt，供 update_block 对照） */
export interface CurrentDocBlockRef {
  id: string
  type: string
  preview: string
}

const MAX_WRITABLE_BLOCKS = 80
const PREVIEW_LEN = 72
const MAX_BLOCK_TABLE_CHARS = 2500

export interface ChatPromptInput {
  /** 完整对话历史（已包含当前用户消息） */
  messages: ChatMessage[]
  /** 检索召回的 blocks，按最终排序传入 */
  citations: Citation[]
  /** 当前查看的文档标题 */
  currentDocTitle?: string
  /** 当前查看文档 ID（有 contextDocId 时与正文一起注入，供 append / update） */
  currentDocId?: string
  /** 当前查看文档的完整 Markdown 内容（有 contextDocId 时自动加载） */
  currentDocContent?: string
  /** 当前文档可写块表（阅读顺序） */
  currentDocBlocks?: CurrentDocBlockRef[]
  /** 历史压缩阈值 */
  maxHistoryTurns?: number
  /** 可用工具定义；为空时不在 system prompt 描述工具能力 */
  tools?: ToolDefinition[]
  /** 助手语言：zh / en（默认 zh） */
  lang?: AiLang
  /** 首轮跳过全库检索时，空 citations 不要写成「笔记里没找到」 */
  skipRetrieval?: boolean
}

const SYSTEM_PROMPT_ZH = `你是 NoteFast 的 AI 助手，正在与用户讨论他的个人知识库。

规则：
1. 回答必须严格基于下方"检索到的笔记"。严禁凭空编造任何信息、文档标题、内容或事实。如果笔记中没有任何相关内容，请直接说明"我的笔记里没有找到相关内容"，不要尝试推测或补全。
2. 在引用任何具体内容时，用 [1]、[2] 这种方括号编号标注来源，对应下方"检索到的笔记"的序号。
3. 回答简洁直接，避免套话和重复问题。如果你不确定，就说不确定——不要为了凑字数而编造。
4. 如果用户问的是方法/步骤，优先引用相关笔记而不是泛泛而谈。没有检索到相关内容时，不要提供"常见做法"或"通用建议"，直接说明未找到。
5. 用户当前正在查看的文档（如有）具有更高优先级——可以引用但不要假设用户只关心这一个文档。
6. 若初始检索结果不充分、用户问得更具体、或需要时间维度（"上周写过什么"），调用 notefast_search_more 重新检索，不要硬猜。
7. 用户要求"记下来""保存""新建笔记""创建文档"时，调用 notefast_create_note 写入新笔记。创建后简要告知用户已保存，并提供 doc_id。用户没有指定标签时不要打标签、不要在正文写 YAML tags；若指定了标签，用 tags 参数传入。
8. 用户要求"加到 XX 笔记里""补充到 XX 文档""追加"时，调用 notefast_append_to_doc。需要准确的 doc_id：正在查看某篇时用下方当前文档的 doc_id；否则从检索结果的 block.doc_id 获取。操作完成后告知用户是否成功。
9. 写操作前先确认：如果用户提到的是模糊名称而非具体 doc_id，先检索找到目标文档再写。不要猜测 doc_id。改当前正在查看的文档时，用下方可写块表的 block_id，不要从检索结果猜其他文档的块。改一篇里的多处时，同一轮可以并行调用多个 notefast_update_block / notefast_append_to_doc，把用户交代的修改做完再总结，不要改一处就结束。
10. 如果用户的问题在你的知识库笔记中找不到答案（如问外部新闻、最新资讯、技术动态），且 notefast_web_search 可用，调用它搜索互联网补充信息。来自网络的搜索结果用 🌐 标注来源 URL，与笔记引用 [n] 区分开。
11. 检索结果只是 block 级片段，不是完整文档。当用户问的是某篇文章的整体内容（"那篇文章具体说了什么""总结一下这篇"）或片段不足以回答时，调用 notefast_read_doc 拉取整篇 Markdown，不要仅凭片段猜测全文。
12. 输出数学公式时，行内公式用 $...$，块级公式用独占行 $$...$$ 或 \`\`\`math 围栏。不要用单行 $$x$$、\\[...\\] 或 \\(...\\)。行内 $ 不要包住货币（如 $5-$10）。
13. 用户要求「固定这个筛选」「加一个 work 标签的固定视图」「把未打标的笔记钉到侧栏」时，调用 notefast_pin_view。不要发明用户没提过的筛选；新建前可用 notefast_list_pinned_views 避免重复。取消固定用 notefast_unpin_view。`

const SYSTEM_PROMPT_EN = `You are NoteFast's AI assistant, discussing the user's personal knowledge base with them.

Rules:
1. Base your answers strictly on the "Retrieved notes" below. Never fabricate any information, document titles, content, or facts. If the notes contain nothing relevant, say directly "I couldn't find anything relevant in my notes" — do not guess or fill in.
2. When citing specific content, mark the source with bracketed numbers like [1], [2], matching the order of the "Retrieved notes" below.
3. Answer concisely and directly; avoid filler and repeating the question. If you're unsure, say so — don't invent content to pad the answer.
4. If the user asks about a method or procedure, cite the relevant notes rather than speaking generally. If nothing relevant was retrieved, don't offer "common practice" or "general advice" — say it wasn't found.
5. The document the user is currently viewing (if any) has higher priority — you may cite it, but don't assume it's the only document they care about.
6. If the initial retrieval is insufficient, the user gets more specific, or a time dimension is needed ("what did I write last week"), call notefast_search_more to re-search instead of guessing.
7. When the user says "note this down", "save this", "create a note", or "create a document", call notefast_create_note to write a new note. After creating, briefly tell the user it's saved and provide the doc_id. Do not add tags unless the user named them — don't invent YAML frontmatter tags either; pass user-specified tags via the tags parameter.
8. When the user says "add this to note XX", "append to document XX", or "append", call notefast_append_to_doc. You need an accurate doc_id: if they are viewing a document, use that doc_id from the current-document section below; otherwise take it from block.doc_id in the retrieval results. After the operation, tell the user whether it succeeded.
9. Confirm before writing: if the user refers to a vague name rather than a concrete doc_id, search to find the target document first, then write. Don't guess doc_id. When editing the document they are viewing, use block_id values from the writable-block table below — do not pick blocks from retrieval hits in other documents. When editing several places in one document, call multiple notefast_update_block / notefast_append_to_doc in the same round and finish all requested edits before summarizing — don't stop after one change.
10. If the user's question can't be answered from your knowledge base notes (e.g. external news, latest updates, tech trends) and notefast_web_search is available, call it to search the internet for supplementary info. Mark web-search results with 🌐 and the source URL to distinguish them from note citations [n].
11. Retrieval results are block-level snippets, not full documents. When the user asks about a document's overall content ("what did that article say exactly", "summarize this") or the snippets are insufficient, call notefast_read_doc to pull the full Markdown instead of guessing from snippets.
12. When outputting math, use $...$ for inline formulas and exclusive-line $$...$$ or \`\`\`math fences for display formulas. Do not use single-line $$x$$, \\[...\\], or \\(...\\). Do not wrap currency like $5-$10 in inline $.
13. When the user asks to pin a filter, add a sidebar pinned view (e.g. "pin the work tag"), or pin untagged notes, call notefast_pin_view. Do not invent filters the user did not mention; list existing views with notefast_list_pinned_views first if needed. Unpin with notefast_unpin_view.`

export function previewBlockLine(content: string, max = PREVIEW_LEN): string {
  const one = content.replace(/\s+/g, ' ').trim()
  if (!one) return ''
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/** 从阅读顺序的块列表生成可写块表（截断过长文档） */
export function toCurrentDocBlockRefs(
  blocks: Array<{ id: string; type: string; content: string }>,
): CurrentDocBlockRef[] {
  const refs: CurrentDocBlockRef[] = []
  for (const b of blocks) {
    const preview = previewBlockLine(b.content)
    if (!preview && b.type !== 'document') continue
    refs.push({ id: b.id, type: b.type, preview: preview || '(empty)' })
    if (refs.length >= MAX_WRITABLE_BLOCKS) break
  }
  return refs
}

export function buildChatPrompt(input: ChatPromptInput): ChatMessage[] {
  const { messages, citations, tools, lang = 'zh', skipRetrieval } = input
  const maxTurns = input.maxHistoryTurns ?? 6
  const system = lang === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH

  const systemContent = `${system}\n\n${buildContextBlock({
    citations,
    currentDocId: input.currentDocId,
    currentDocTitle: input.currentDocTitle,
    currentDocContent: input.currentDocContent,
    currentDocBlocks: input.currentDocBlocks,
    lang,
    skipRetrieval: skipRetrieval === true,
  })}`

  let withTools = systemContent
  if (tools && tools.length > 0) {
    withTools += `\n\n${buildToolsBlock(tools, lang)}`
  }

  const history = compressHistory(messages, maxTurns)

  return [{ role: 'system', content: withTools }, ...history]
}

function buildWritableBlockTable(blocks: CurrentDocBlockRef[], lang: AiLang): string {
  const en = lang === 'en'
  const lines: string[] = []
  let used = 0
  let omitted = 0
  for (const b of blocks) {
    const line = `- block_id: ${b.id} · ${b.type} · ${b.preview}`
    if (used + line.length + 1 > MAX_BLOCK_TABLE_CHARS) {
      omitted = blocks.length - lines.length
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  const head = en
    ? 'Writable blocks (notefast_update_block uses these block_id values; append with the doc_id above). Do not edit blocks from other documents in the retrieval hits unless the user named those notes.'
    : '可写块（notefast_update_block 用这些 block_id；追加用上方 doc_id）。未点名其他笔记时，不要改检索结果里其他文档的块。'
  const tail = omitted > 0
    ? (en ? `\n… (${omitted} more blocks omitted; call notefast_read_doc if needed)` : `\n…（其余 ${omitted} 块已省略；需要时调用 notefast_read_doc）`)
    : ''
  return `${head}\n${lines.join('\n')}${tail}\n\n`
}

function buildContextBlock(opts: {
  citations: Citation[]
  currentDocId?: string
  currentDocTitle?: string
  currentDocContent?: string
  currentDocBlocks?: CurrentDocBlockRef[]
  lang: AiLang
  skipRetrieval: boolean
}): string {
  const { citations, currentDocId, currentDocTitle, currentDocContent, currentDocBlocks, lang, skipRetrieval } = opts
  const en = lang === 'en'
  const hasCurrent = Boolean(currentDocTitle || currentDocContent || currentDocId)
  let docBlock = ''
  if (hasCurrent) {
    docBlock = currentDocTitle
      ? (en ? `The document the user is currently viewing: "${currentDocTitle}"\n` : `用户当前查看文档：《${currentDocTitle}》\n`)
      : (en ? 'The user is currently browsing a document\n' : '用户当前正在浏览一篇文档\n')
    if (currentDocId) {
      docBlock += `doc_id: ${currentDocId}\n`
    }
    if (currentDocContent) {
      // 截断过长内容，为检索结果留空间
      const maxLen = 4000
      const truncated = currentDocContent.length > maxLen
        ? currentDocContent.slice(0, maxLen) + (en ? '\n\n... (document too long, truncated. Use notefast_read_doc for the full text)' : '\n\n... (文档过长，已截断。可使用 notefast_read_doc 读取全文)')
        : currentDocContent
      docBlock += en ? `\nFull content:\n---\n${truncated}\n---\n\n` : `\n完整内容：\n---\n${truncated}\n---\n\n`
    } else {
      docBlock += '\n'
    }
    if (currentDocBlocks && currentDocBlocks.length > 0) {
      docBlock += buildWritableBlockTable(currentDocBlocks, lang)
    }
  }
  if (citations.length === 0) {
    if (skipRetrieval && hasCurrent) {
      return en
        ? `${docBlock}(No library search this round. Answer from the current document above. If the body was truncated, call notefast_read_doc. Do not call notefast_search_more unless the user asks about other notes.)`
        : `${docBlock}（本轮未做全库检索。请根据上方当前文档作答；若正文被截断可调用 notefast_read_doc。用户没有问及其他笔记时，不要调用 notefast_search_more。）`
    }
    if (skipRetrieval) {
      return en
        ? `${docBlock}(No library search this round. Use tools such as notefast_list_docs as the user requested. Do not invent document titles.)`
        : `${docBlock}（本轮未做全库检索。请按用户要求调用 notefast_list_docs 等工具，不要编造文档标题。）`
    }
    return en
      ? `${docBlock}(No relevant notes were retrieved this time. Tell the user directly that nothing relevant was found — do not fabricate or guess. If the question is a listing query like "what documents are there" or "list all", consider calling notefast_list_docs to fetch the document list.)`
      : `${docBlock}(本次未检索到相关笔记。请直接告知用户未找到相关内容，不要编造或猜测。若用户的问题涉及"有哪些""列出所有"等列表性查询，建议调用 notefast_list_docs 获取文档列表。)`
  }
  const items = citations
    .map((c, i) => {
      // doc_id / block_id 必须随结果注入：read_doc / update_block 的指引是「ID 从检索结果获取」，
      // 不渲染出来模型就只能报「检索结果中没有 doc_id」
      const head = en
        ? `[${i + 1}] Document "${c.doc_title}" · ${c.type} · doc_id: ${c.doc_id} · block_id: ${c.block_id}`
        : `[${i + 1}] 文档《${c.doc_title}》 · ${c.type} · doc_id: ${c.doc_id} · block_id: ${c.block_id}`
      const body = c.content
      const tail = c.type === 'code' ? '\n```' : ''
      const prefix = c.type === 'code' ? '```\n' : ''
      return `${head}\n${prefix}${body}${tail}`
    })
    .join('\n\n')
  return en
    ? `${docBlock}Retrieved notes (${citations.length} total):\n\n${items}`
    : `${docBlock}检索到的笔记（共 ${citations.length} 条）：\n\n${items}`
}

function buildToolsBlock(tools: ToolDefinition[], lang: AiLang = 'zh'): string {
  const en = lang === 'en'
  const lines = tools.map((t) => {
    const params = JSON.stringify(t.function.parameters, null, 2)
    return `- **${t.function.name}**: ${t.function.description}\n  ${en ? 'Parameters:' : '参数:'}\n  \`\`\`json\n  ${params}\n  \`\`\``
  })
  return en
    ? `Available tools (call when needed; at most 3 consecutive rounds):\n\n${lines.join('\n\n')}\n\nCall by returning a tool_calls field with JSON parameter objects. Call only 1–2 tools at a time to avoid noise. Write tools don't need a second confirmation.`
    : `可用工具（必要时调用；最多连续 3 轮）：\n\n${lines.join('\n\n')}\n\n调用方式：返回 tool_calls 字段，参数用 JSON 对象。每次只调 1~2 个工具，避免噪音。写工具执行后不需要二次确认。`
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
