/**
 * Chat 编排层（v2）
 *
 * 输入：用户的多轮对话 + 可选 doc hint / 时间窗 / notebook 范围
 * 输出：AsyncIterable<ChatEvent>，对应 Hono streamSSE 的事件流
 *
 *   event: retrieval → 初次检索完成
 *   event: tool      → agent loop 中工具调用完成
 *   event: reasoning → 思考链增量（可选）
 *   event: token     → 流式 token
 *   event: done      → 流结束（带 citations + toolTrace）
 *   event: error     → 出错
 *
 * 流程：
 *  1. hybridSearch() 拿 citations（embedding 不可用时降级到 FTS5）
 *  2. buildChatPrompt() 组装 prompt（含 tool 定义）
 *  3. agent loop（最多 N 轮）：
 *     a. runtime.streamChatWithTools() → 流式 content/reasoning + 可选 tool_calls
 *     b. 若有 tool_calls：执行 search_more → 结果回填 prompt → 下一轮
 *     c. 否则 → 答案已在流中发出
 */

import type { ChatMessage, ToolCall, ToolDefinition, BlockRow } from '@notefast/core'
import { ThinkStreamParser, splitThinkContent, rowToBlock, readDocStatus, readTags, parseStaleWithin, parseUpdatedWithin, messageText, buildBlockTree, blocksToMarkdown } from '@notefast/core'
import type { Citation } from './hybridSearch'
import { getDb } from '../db'
import { fetchDocBlocks } from '../dbQueries'
import { hybridSearch, type HybridSearchReport } from './hybridSearch'
import { buildChatPrompt } from './prompt'
import { getRuntime, hasRuntime } from '../services/aiRuntime'
import { insertDocFromMarkdown, appendMarkdownToDoc } from '../services/docImport'
import { computeContentHash } from '../services/contentHash'
import { fireAfterCreate, fireAfterCreateMany, fireAfterUpdate } from '../services/hooks'
import { scheduleDocIndex } from './indexJobs'
import { loadAiExcludedDocIds } from './aiExcludeQuery'
import { searchWeb } from './webSearch'

export type ChatEvent =
  | { type: 'retrieval'; report: HybridSearchReport }
  | { type: 'tool'; tool: string; args: Record<string, unknown>; resultCount: number }
  | { type: 'reasoning'; content: string }
  | { type: 'token'; content: string }
  | { type: 'done'; citations: Citation[]; retrieval: HybridSearchReport['retrieval']; toolTrace: ToolTraceEntry[] }
  | { type: 'error'; error: ChatError }

export interface ChatError {
  code: 'not_configured' | 'no_user_message' | 'llm_error' | 'stream_error'
  message: string
  fix_hint?: string
}

export interface ToolTraceEntry {
  tool: string
  args: Record<string, unknown>
  result_count: number
  result_text?: string
}

export interface ToolResult {
  content: string
  resultCount: number
}

export interface RunChatOptions {
  messages: ChatMessage[]
  contextDocId?: string
  notebookId?: string
  /** 时间窗下界（ISO），转 hybridSearch 的 since */
  since?: string
  /** 时间窗上界（ISO），转 hybridSearch 的 until */
  until?: string
  topK?: number
  ftsLimit?: number
  semanticLimit?: number
  rerankWindow?: number
  /** 引用相关性最低分（见 hybridSearch SearchOptions.minScore；默认 0 不过滤） */
  minScore?: number
  temperature?: number
  maxTokens?: number
  /** 是否启用 agent loop（tool-call）；默认 true（若模型支持）。false 时降级为一次性检索 */
  enableTools?: boolean
  /** agent loop 最大轮数，默认 3 */
  maxToolRounds?: number
}

const FIX_HINT = '请在 Web UI /settings 页面配置 Chat 模型（API Key + Base URL + 模型名）'
const DEFAULT_MAX_TOOL_ROUNDS = 3

/**
 * 暴露给 LLM 的工具定义。
 * 当前只有 notefast_search_more：让 LLM 在初始检索结果不满意时主动重检。
 */
function getSearchToolDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'notefast_search_more',
      description:
        '用不同的关键词、缩小范围、加时间窗等条件重新检索知识库。当初始结果不够、用户问得更具体、或需要时间维度（"上次我写过什么"）时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '新关键词；留空则用当前对话最后一条 user 消息' },
          notebook_id: { type: 'string', description: '限定到某个 notebook（可选）' },
          since: { type: 'string', description: 'ISO 时间字符串，只返回 blocks.updated_at >= since 的块' },
          until: { type: 'string', description: 'ISO 时间字符串，只返回 blocks.updated_at <= until 的块' },
          limit: { type: 'number', description: '返回的引用数量（1-20）', default: 5 },
          include_archived: { type: 'boolean', description: '是否包含已归档文档（默认 false；仅当用户明确要找过时/历史内容时置 true）' },
        },
      },
    },
  }
}

/** 文档列表工具：让 LLM 能回答"有哪些笔记/收集箱里有什么/哪些长期没更新"类问题 */
function getListDocsToolDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'notefast_list_docs',
      description:
        '列出知识库文档（标题/状态/标签/更新时间）。用于"我有哪些笔记""收集箱里有什么""找长期未更新的文档"等列表性场景；需要具体内容时再调用 notefast_search_more。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['note', 'inbox', 'archived', 'all'], description: 'note=正式笔记（默认）；inbox=收集箱；archived=归档；all=全部' },
          stale_within: { type: 'string', enum: ['30d', '90d'], description: '仅返回超过该时长未更新的文档（找过时内容用）' },
          updated_within: { type: 'string', enum: ['24h', '7d'], description: '仅返回最近更新的文档' },
          limit: { type: 'number', description: '返回数量（1-50），默认 20' },
        },
      },
    },
  }
}

/** 读全文工具：检索只给片段，需要完整文章时让 LLM 主动拉取整篇 Markdown */
function getReadDocToolDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'notefast_read_doc',
      description:
        '读取一篇文档的完整内容（Markdown）。检索结果只是 block 级片段，当需要完整文章、总结全文、或片段不足以回答时调用。doc_id 从检索结果或 notefast_list_docs 获取。',
      parameters: {
        type: 'object',
        properties: {
          doc_id: { type: 'string', description: '目标文档 ID' },
        },
        required: ['doc_id'],
      },
    },
  }
}

function getWriteToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'notefast_create_note',
        description: '在知识库中创建一篇新笔记。标题必须简洁（5-20字），内容用 Markdown。当用户要求"记下来""保存这段""新建笔记"时调用。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '笔记标题，5-20字' },
            markdown: { type: 'string', description: '笔记正文，Markdown 格式' },
            status: { type: 'string', enum: ['note', 'inbox'], description: 'note=正式笔记，inbox=收集箱；默认 note' },
          },
          required: ['title', 'markdown'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'notefast_append_to_doc',
        description: '向已有文档末尾追加一段内容。doc_id 从检索结果中的 block.doc_id 获取。当用户要求"加到那篇笔记里""补充到 XX 文档"时调用。',
        parameters: {
          type: 'object',
          properties: {
            doc_id: { type: 'string', description: '目标文档 ID（从检索结果或之前的对话中获取）' },
            content: { type: 'string', description: '要追加的内容，Markdown 格式' },
            heading: { type: 'string', description: '追加内容前先插入的标题（可选），如"## 补充"' },
          },
          required: ['doc_id', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'notefast_update_block',
        description: '更新已有 block 的内容。block_id 从检索结果的 citation.block_id 获取。当用户要求"修改那段""改成 XX"时调用。',
        parameters: {
          type: 'object',
          properties: {
            block_id: { type: 'string', description: '目标 block ID（从检索结果的 citation.block_id 获取）' },
            content: { type: 'string', description: '新内容，Markdown 格式' },
          },
          required: ['block_id', 'content'],
        },
      },
    },
  ]
}

function getAllToolDefinitions(): ToolDefinition[] {
  const tools: ToolDefinition[] = [getSearchToolDefinition(), getListDocsToolDefinition(), getReadDocToolDefinition(), ...getWriteToolDefinitions()]
  if (hasRuntime() && getRuntime().webSearchKey()) {
    tools.push({
      type: 'function',
      function: {
        name: 'notefast_web_search',
        description: '搜索互联网获取最新信息。当用户的问题在知识库笔记中找不到答案、需要外部最新资讯时调用。结果来自网络，与笔记引用分开标注。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            count: { type: 'number', description: '返回条数（1-10），默认 5' },
          },
          required: ['query'],
        },
      },
    })
  }
  return tools
}

/**
 * 执行 LLM 请求的工具调用。
 * 当前只支持 notefast_search_more；其它工具返回空结果，避免 LLM 调用未实现的工具。
 */
async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  fallbackQuery: string,
  ctx: { notebookId?: string; ctxDocId?: string; since?: string; until?: string; minScore?: number },
): Promise<ToolResult> {
  if (name === 'notefast_search_more') {
    const q = (typeof args.query === 'string' && args.query.trim()) || fallbackQuery
    const notebookId = (typeof args.notebook_id === 'string' ? args.notebook_id : undefined) || ctx.notebookId
    const since = (typeof args.since === 'string' ? args.since : undefined) || ctx.since
    const until = (typeof args.until === 'string' ? args.until : undefined) || ctx.until
    const limit = typeof args.limit === 'number' ? Math.min(20, Math.max(1, args.limit)) : 5

    const report = await hybridSearch({
      query: q,
      notebookId,
      since,
      until,
      topK: limit,
      minScore: ctx.minScore,
      includeArchived: args.include_archived === true,
    })
    return {
      content: JSON.stringify({
        citations: report.citations.map((c) => ({
          block_id: c.block_id,
          doc_id: c.doc_id,
          doc_title: c.doc_title,
          snippet: c.snippet,
          score: c.score,
        })),
        retrieval: report.retrieval,
      }),
      resultCount: report.citations.length,
    }
  }

  if (name === 'notefast_list_docs') {
    const db = getDb()
    const status = typeof args.status === 'string' ? args.status : 'note'
    const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, args.limit)) : 20
    const staleMs = parseStaleWithin(typeof args.stale_within === 'string' ? args.stale_within : null)
    const updatedMs = parseUpdatedWithin(typeof args.updated_within === 'string' ? args.updated_within : null)

    let rows = db
      .query("SELECT * FROM blocks WHERE type = 'document' AND is_deleted = 0 ORDER BY updated_at DESC")
      .all() as BlockRow[]
    const excluded = loadAiExcludedDocIds(rows.map((r) => r.id))
    rows = rows.filter((r) => !excluded.has(r.id))
    if (status !== 'all') rows = rows.filter((r) => readDocStatus(r) === status)
    if (staleMs != null) {
      const cutoff = Date.now() - staleMs
      rows = rows.filter((r) => new Date(r.updated_at).getTime() <= cutoff)
    }
    if (updatedMs != null) {
      const cutoff = Date.now() - updatedMs
      rows = rows.filter((r) => new Date(r.updated_at).getTime() >= cutoff)
    }

    const docs = rows.slice(0, limit).map((r) => ({
      doc_id: r.id,
      title: r.content,
      status: readDocStatus(r),
      tags: readTags(r),
      updated_at: r.updated_at,
    }))
    return { content: JSON.stringify({ docs, total: rows.length }), resultCount: docs.length }
  }

  if (name === 'notefast_read_doc') {
    const docId = typeof args.doc_id === 'string' ? args.doc_id.trim() : ''
    if (!docId) {
      return { content: JSON.stringify({ error: 'doc_id 不能为空' }), resultCount: 0 }
    }
    const db = getDb()
    const docRow = db
      .query("SELECT * FROM blocks WHERE id = ? AND type = 'document' AND is_deleted = 0")
      .get(docId) as BlockRow | undefined
    if (!docRow) {
      return { content: JSON.stringify({ error: `文档 ${docId} 不存在` }), resultCount: 0 }
    }
    const excluded = loadAiExcludedDocIds([docId])
    if (excluded.has(docId)) {
      return { content: JSON.stringify({ error: `文档 ${docId} 已对 AI 隐藏` }), resultCount: 0 }
    }
    let markdown = blocksToMarkdown(buildBlockTree(fetchDocBlocks(db, docId)))
    // 上限防超长文档撑爆上下文；截断时明确告知，LLM 可改用 search_more 定位
    const MAX_DOC_CHARS = 12_000
    const truncated = markdown.length > MAX_DOC_CHARS
    if (truncated) markdown = markdown.slice(0, MAX_DOC_CHARS)
    return {
      content: JSON.stringify({
        doc_id: docId,
        title: docRow.content,
        markdown,
        ...(truncated ? { truncated: true, note: `文档过长，仅返回前 ${MAX_DOC_CHARS} 字符` } : {}),
      }),
      resultCount: 1,
    }
  }

  if (name === 'notefast_create_note') {
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    const markdown = typeof args.markdown === 'string' ? args.markdown : ''
    if (!title || !markdown) {
      return { content: JSON.stringify({ error: 'title 和 markdown 不能为空' }), resultCount: 0 }
    }
    const status = args.status === 'inbox' ? 'inbox' : 'note'
    const db = getDb()
    const notebookId = ctx.notebookId || guessNotebookId(db)
    try {
      const result = insertDocFromMarkdown(db, {
        notebookId,
        title,
        markdown,
        status,
      })
      // 与 MCP notefast_create_doc 对齐：索引作业 + afterCreate hooks（doc 先、子块批量），
      // 否则聊天创建的笔记跳过自动索引与 doc 变更广播
      const docRow = db.query('SELECT * FROM blocks WHERE id = ?').get(result.docId) as BlockRow
      const indexJob = scheduleDocIndex(result.docId, result.blockIds)
      fireAfterCreate(rowToBlock(docRow))
      if (result.blockIds.length > 0) {
        const placeholders = result.blockIds.map(() => '?').join(',')
        const childRows = db
          .query(`SELECT * FROM blocks WHERE id IN (${placeholders})`)
          .all(...result.blockIds) as BlockRow[]
        fireAfterCreateMany(childRows.map(rowToBlock))
      }
      return {
        content: JSON.stringify({
          success: true,
          doc_id: result.docId,
          title,
          block_count: result.parsedCount + 1,
          status,
          ...(indexJob ? { index_job: indexJob } : {}),
        }),
        resultCount: 1,
      }
    } catch (e) {
      return {
        content: JSON.stringify({ error: `创建笔记失败: ${e instanceof Error ? e.message : e}` }),
        resultCount: 0,
      }
    }
  }

  if (name === 'notefast_append_to_doc') {
    const docId = typeof args.doc_id === 'string' ? args.doc_id.trim() : ''
    const content = typeof args.content === 'string' ? args.content : ''
    if (!docId || !content) {
      return { content: JSON.stringify({ error: 'doc_id 和 content 不能为空' }), resultCount: 0 }
    }
    const db = getDb()
    const doc = db.query("SELECT id, notebook_id FROM blocks WHERE id = ? AND type = 'document'").get(docId) as
      | { id: string; notebook_id: string } | undefined
    if (!doc) {
      return { content: JSON.stringify({ error: `文档 ${docId} 不存在` }), resultCount: 0 }
    }
    const excluded = loadAiExcludedDocIds([docId])
    if (excluded.has(docId)) {
      return { content: JSON.stringify({ error: `文档 ${docId} 已对 AI 隐藏` }), resultCount: 0 }
    }

    const heading = typeof args.heading === 'string' && args.heading.trim()
    const fullContent = heading ? `${heading}\n\n${content}` : content

    // 追加内容与编辑保存同语义：解析为结构化 block 树入库，
    // 否则整段 Markdown 原文会成为单个 paragraph，预览把 ```、表格等按纯文本渲染
    const { blockIds, parsedCount } = appendMarkdownToDoc(db, {
      docId,
      notebookId: doc.notebook_id,
      markdown: fullContent,
    })
    if (parsedCount === 0) {
      return { content: JSON.stringify({ error: '内容无法解析为有效 block' }), resultCount: 0 }
    }

    // 与 PUT /docs/:id/markdown 一致的副作用：索引作业 + afterCreate hooks + 更新文档
    const indexJob = scheduleDocIndex(docId, blockIds)
    if (blockIds.length > 0) {
      const placeholders = blockIds.map(() => '?').join(',')
      const newRows = db
        .query(`SELECT * FROM blocks WHERE id IN (${placeholders})`)
        .all(...blockIds) as BlockRow[]
      fireAfterCreateMany(newRows.map(rowToBlock))
    }
    const updatedDocRow = db.query('SELECT * FROM blocks WHERE id = ?').get(docId) as BlockRow
    fireAfterUpdate(rowToBlock(updatedDocRow))

    return {
      content: JSON.stringify({
        success: true,
        block_ids: blockIds,
        block_count: parsedCount,
        doc_id: docId,
        ...(indexJob ? { index_job: indexJob } : {}),
        message: `已将 ${parsedCount} 个 block 追加到文档 ${docId}`,
      }),
      resultCount: 1,
    }
  }

  if (name === 'notefast_update_block') {
    const blockId = typeof args.block_id === 'string' ? args.block_id.trim() : ''
    const newContent = typeof args.content === 'string' ? args.content : ''
    if (!blockId || !newContent) {
      return { content: JSON.stringify({ error: 'block_id 和 content 不能为空' }), resultCount: 0 }
    }
    const db = getDb()
    const row = db.query('SELECT id, root_id FROM blocks WHERE id = ?').get(blockId) as
      | { id: string; root_id: string } | undefined
    if (!row) {
      return { content: JSON.stringify({ error: `Block ${blockId} 不存在` }), resultCount: 0 }
    }
    const excluded = loadAiExcludedDocIds([row.root_id])
    if (excluded.has(row.root_id)) {
      return { content: JSON.stringify({ error: `Block ${blockId} 所属文档已对 AI 隐藏` }), resultCount: 0 }
    }
    db.query(
      "UPDATE blocks SET content = ?, content_hash = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(newContent, computeContentHash(newContent), blockId)
    return {
      content: JSON.stringify({
        success: true,
        block_id: blockId,
        message: `已更新 block ${blockId.slice(0, 8)}`,
      }),
      resultCount: 1,
    }
  }

  if (name === 'notefast_web_search') {
    const q = typeof args.query === 'string' ? args.query.trim() : ''
    if (!q) {
      return { content: JSON.stringify({ error: 'query 不能为空' }), resultCount: 0 }
    }
    if (!hasRuntime()) {
      return { content: JSON.stringify({ error: 'AI runtime 未初始化' }), resultCount: 0 }
    }
    const runtime = getRuntime()
    const apiKey = runtime.webSearchKey()
    if (!apiKey) {
      return { content: JSON.stringify({ error: '网页搜索未配置，请在 /settings 中设置 Brave Search API Key' }), resultCount: 0 }
    }
    const count = typeof args.count === 'number' ? Math.min(10, Math.max(1, args.count)) : 5
    try {
      const results = await searchWeb(q, apiKey, count)
      return {
        content: JSON.stringify({
          query: q,
          results: results.map((r, i) => ({
            index: i + 1,
            title: r.title,
            url: r.url,
            snippet: r.snippet,
          })),
        }),
        resultCount: results.length,
      }
    } catch (e) {
      return {
        content: JSON.stringify({ error: `网页搜索失败: ${e instanceof Error ? e.message : e}` }),
        resultCount: 0,
      }
    }
  }

  return { content: JSON.stringify({ error: `未知工具 ${name}` }), resultCount: 0 }
}

function guessNotebookId(db: ReturnType<typeof getDb>): string {
  const row = db.query("SELECT id FROM notebooks ORDER BY created_at ASC LIMIT 1").get() as
    | { id: string } | undefined
  return row?.id ?? 'default'
}

/** 把流式 chunk 经 Think 标签拆分后 yield 为 reasoning / token 事件 */
async function* emitStreamChunks(
  source: AsyncIterable<{ content?: string; reasoning?: string; done?: boolean; tool_calls?: ToolCall[] }>,
): AsyncGenerator<ChatEvent, ToolCall[]> {
  const parser = new ThinkStreamParser()
  let toolCalls: ToolCall[] = []
  for await (const chunk of source) {
    if (chunk.reasoning) yield { type: 'reasoning', content: chunk.reasoning }
    if (chunk.content) {
      const split = parser.push(chunk.content)
      if (split.reasoning) yield { type: 'reasoning', content: split.reasoning }
      if (split.content) yield { type: 'token', content: split.content }
    }
    if (chunk.done) {
      const flushed = parser.flush()
      if (flushed.reasoning) yield { type: 'reasoning', content: flushed.reasoning }
      if (flushed.content) yield { type: 'token', content: flushed.content }
      if (chunk.tool_calls && chunk.tool_calls.length > 0) toolCalls = chunk.tool_calls
    }
  }
  return toolCalls
}

/** 非流式整包答案：拆 think 后按事件发出（降级路径） */
function* emitCompleteAnswer(content: string, reasoning?: string): Generator<ChatEvent> {
  if (reasoning) yield { type: 'reasoning', content: reasoning }
  const split = splitThinkContent(content)
  if (split.reasoning) yield { type: 'reasoning', content: split.reasoning }
  if (split.content) yield { type: 'token', content: split.content }
}

/**
 * 生成完整事件流。调用方通过 for-await 消费并写入 Hono streamSSE。
 */
export async function* runChat(opts: RunChatOptions): AsyncGenerator<ChatEvent> {
  if (!hasRuntime()) {
    yield {
      type: 'error',
      error: {
        code: 'not_configured',
        message: 'AI runtime 未初始化',
        fix_hint: FIX_HINT,
      },
    }
    return
  }
  const runtime = getRuntime()
  if (!runtime.hasChat()) {
    yield {
      type: 'error',
      error: {
        code: 'not_configured',
        message: 'AI chat 未配置',
        fix_hint: FIX_HINT,
      },
    }
    return
  }

  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user')
  const lastUserText = lastUser ? messageText(lastUser.content) : ''
  if (!lastUser || !lastUserText.trim()) {
    yield {
      type: 'error',
      error: { code: 'no_user_message', message: '未提供用户消息' },
    }
    return
  }

  // ① 初次检索
  let initialReport: HybridSearchReport
  try {
    initialReport = await hybridSearch({
      query: lastUserText,
      contextDocId: opts.contextDocId,
      notebookId: opts.notebookId,
      since: opts.since,
      until: opts.until,
      topK: opts.topK,
      ftsLimit: opts.ftsLimit,
      semanticLimit: opts.semanticLimit,
      rerankWindow: opts.rerankWindow,
      minScore: opts.minScore,
    })
  } catch (e) {
    initialReport = {
      citations: [],
      retrieval: {
        fts_hits: 0,
        semantic_hits: 0,
        reranked: false,
        timing: { fts_ms: 0, embed_query_ms: 0, semantic_ms: 0, rerank_ms: 0, total_ms: 0 },
      },
    }
    console.error('[chat] retrieval failed:', e)
  }

  const currentDocTitle = opts.contextDocId ? lookupDocTitle(opts.contextDocId) : undefined
  const toolTrace: ToolTraceEntry[] = []
  const enableTools = opts.enableTools !== false
  const maxRounds = opts.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS

  // ② 拼装 prompt（含 tool 定义）
  const promptMessages = buildChatPrompt({
    messages: opts.messages,
    citations: initialReport.citations,
    currentDocTitle,
    tools: enableTools ? getAllToolDefinitions() : undefined,
  })

  yield { type: 'retrieval', report: initialReport }

  // ③ agent loop + 流式输出最终答案
  try {
    let workingMessages = promptMessages.slice()
    let finalCitations = initialReport.citations
    let finalRetrieval = initialReport.retrieval

    for (let round = 0; round <= maxRounds; round++) {
      if (enableTools) {
        let toolCalls: ToolCall[] = []
        let streamFailed = false
        const llmStart = Date.now()
        try {
          const gen = emitStreamChunks(
            runtime.streamChatWithTools(workingMessages, {
              temperature: opts.temperature ?? 0.3,
              maxTokens: opts.maxTokens ?? 2000,
              tools: getAllToolDefinitions(),
            }),
          )
          let next = await gen.next()
          while (!next.done) {
            yield next.value
            next = await gen.next()
          }
          toolCalls = next.value
          console.info(JSON.stringify({
            event: 'llm_call',
            round,
            mode: 'stream_tools',
            tool_calls: toolCalls.length,
            duration_ms: Date.now() - llmStart,
          }))
        } catch (e) {
          console.error('[chat] streamChatWithTools failed, falling back:', e)
          streamFailed = true
        }

        if (streamFailed) {
          let recovered = false
          if (typeof runtime.chatWithTools === 'function') {
            try {
              const result = await runtime.chatWithTools(workingMessages, {
                temperature: opts.temperature ?? 0.3,
                maxTokens: opts.maxTokens ?? 2000,
                tools: getAllToolDefinitions(),
              })
              if (result && result.tool_calls.length > 0 && round < maxRounds) {
                toolCalls = result.tool_calls
                recovered = true
              } else if (result) {
                yield* emitCompleteAnswer(result.content || '', result.reasoning)
                break
              }
            } catch (e2) {
              console.error('[chat] chatWithTools fallback failed:', e2)
            }
          }
          if (!recovered && toolCalls.length === 0) {
            for await (const ev of emitStreamChunks(
              runtime.streamChat(workingMessages, {
                temperature: opts.temperature ?? 0.3,
                maxTokens: opts.maxTokens ?? 2000,
              }),
            )) {
              yield ev
            }
            break
          }
        }

        if (toolCalls.length > 0 && round < maxRounds) {
          workingMessages.push({
            role: 'assistant',
            content: '',
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            })),
          })

          for (const tc of toolCalls) {
            const exec = await executeToolCall(tc.name, tc.args, lastUserText, {
              notebookId: opts.notebookId,
              ctxDocId: opts.contextDocId,
              since: opts.since,
              until: opts.until,
              minScore: opts.minScore,
            })
            toolTrace.push({
              tool: tc.name,
              args: tc.args,
              result_count: exec.resultCount,
              result_text: exec.content,
            })
            yield {
              type: 'tool',
              tool: tc.name,
              args: tc.args,
              resultCount: exec.resultCount,
            }
            workingMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: exec.content,
            })

            // 搜索工具的命中结果更新 citations（用于最终返回）
            if (tc.name === 'notefast_search_more') {
              try {
                const parsed = JSON.parse(exec.content)
                if (parsed.citations?.length > 0) {
                  finalCitations = parsed.citations
                  finalRetrieval = parsed.retrieval ?? finalRetrieval
                }
              } catch { /* ignore parse failure */ }
            }
          }
          continue
        }

        // 无 tool call：答案已在流中发出
        break
      } else {
        // 不启用 tools：纯流式
        for await (const ev of emitStreamChunks(
          runtime.streamChat(workingMessages, {
            temperature: opts.temperature ?? 0.3,
            maxTokens: opts.maxTokens ?? 2000,
          }),
        )) {
          yield ev
        }
        break
      }
    }

    yield {
      type: 'done',
      citations: finalCitations,
      retrieval: finalRetrieval,
      toolTrace,
    }
  } catch (e) {
    // 把上游 LLM / runtime 的真实错误打满 stack，容器日志可读；
    // 客户端只看到 sanitized message（避免泄露 API key / 内部栈）
    console.error('[chat] agent loop failed:', e)
    const msg = e instanceof Error ? e.message : String(e)
    const code: ChatError['code'] = msg.includes('is not configured') ? 'not_configured' : 'llm_error'
    yield {
      type: 'error',
      error: {
        code,
        message: msg,
        fix_hint: code === 'not_configured' ? FIX_HINT : undefined,
      },
    }
  }
}

function lookupDocTitle(docId: string): string | undefined {
  try {
    const row = getDb().query('SELECT content FROM blocks WHERE id = ? AND type = ?').get(docId, 'document') as
      | { content: string }
      | undefined
    return row?.content
  } catch {
    return undefined
  }
}

/**
 * 非流式入口：把 runChat 收敛为完整结果，便于 MCP 等同步协议使用。
 * 失败时抛 Error，由调用方转换为 HTTP/MCP 错误。
 */
export async function runChatSync(opts: RunChatOptions): Promise<{
  answer: string
  reasoning?: string
  citations: Citation[]
  retrieval: HybridSearchReport['retrieval']
  toolTrace: ToolTraceEntry[]
}> {
  let answer = ''
  let reasoning = ''
  let citations: Citation[] = []
  let retrieval: HybridSearchReport['retrieval'] = {
    fts_hits: 0,
    semantic_hits: 0,
    reranked: false,
    timing: { fts_ms: 0, embed_query_ms: 0, semantic_ms: 0, rerank_ms: 0, total_ms: 0 },
  }
  let toolTrace: ToolTraceEntry[] = []

  for await (const ev of runChat(opts)) {
    if (ev.type === 'token') answer += ev.content
    else if (ev.type === 'reasoning') reasoning += ev.content
    else if (ev.type === 'done') {
      citations = ev.citations
      retrieval = ev.retrieval
      toolTrace = ev.toolTrace
    } else if (ev.type === 'error') {
      const prefix = ev.error.code === 'not_configured' ? '[未配置] ' : ''
      throw new Error(prefix + ev.error.message)
    }
  }
  return {
    answer,
    ...(reasoning ? { reasoning } : {}),
    citations,
    retrieval,
    toolTrace,
  }
}
