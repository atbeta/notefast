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
 *  3. agent loop（最多 N 轮工具；用尽后纯文字收口）：
 *     a. runtime.streamChatWithTools() → 流式 content/reasoning + 可选 tool_calls
 *     b. 若有 tool_calls：执行 search_more → 结果回填 prompt → 下一轮
 *     c. 否则 → 答案已在流中发出
 */

import type { ChatMessage, ToolCall } from '@notefast/core'
import { ThinkStreamParser, splitThinkContent, readDocStatus, readTags, parseStaleWithin, parseUpdatedWithin, messageText, buildBlockTree, blocksToMarkdown } from '@notefast/core'
import type { Citation } from './hybridSearch'
import { getDb } from '../db'
import {
  fetchDocBlocks,
  getDocById,
  getLiveDocById,
  listDocRows,
} from '../store/blocks'
import { hybridSearch, type HybridSearchReport } from './hybridSearch'
import { listPinnedViews } from '../services/pinnedViews'
import { buildChatPrompt } from './prompt'
import type { AiLang } from './locale'
import { getRuntime, hasRuntime } from '../services/aiRuntime'
import { loadAiExcludedDocIds } from './aiExcludeQuery'
import { searchWeb } from './webSearch'
import { emitAppEvent } from '../events'
import { visionEnabled } from './imageCaptions'
import { executeWriteTool, getAllToolDefinitions, WRITE_TOOLS } from './chatTools'
export { executeWriteTool, getAllToolDefinitions, WRITE_TOOLS, type WriteToolContext } from './chatTools'

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
  /** agent loop 最多执行几轮工具，默认 8；用尽后改纯文字收口，不再丢未执行的 tool_call */
  maxToolRounds?: number
  /** 助手语言：zh / en（默认 zh） */
  lang?: AiLang
  /** 客户端断连信号：贯穿到上游 LLM 请求，断连即取消（省 token） */
  signal?: AbortSignal
}

function fixHint(lang: AiLang): string {
  return lang === 'en'
    ? 'Configure a Chat model in the Web UI /settings page (API Key + Base URL + model name)'
    : '请在 Web UI /settings 页面配置 Chat 模型（API Key + Base URL + 模型名）'
}
const DEFAULT_MAX_TOOL_ROUNDS = 8
/** 聊天默认输出预算：写工具的 arguments（整段 block）容易超过 2000 */
const DEFAULT_CHAT_MAX_TOKENS = 4096

/**
 * 执行 LLM 请求的工具调用。
 * 读工具：search_more / list_docs / read_doc / list_pinned_views / web_search；写工具走 executeWriteTool。
 */
async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  fallbackQuery: string,
  ctx: { notebookId?: string; ctxDocId?: string; since?: string; until?: string; minScore?: number; lang?: AiLang },
): Promise<ToolResult> {
  // 写工具：直接执行（不经过用户确认；文档历史可回退）
  if (WRITE_TOOLS.has(name)) {
    return executeWriteTool(name, args, { notebookId: ctx.notebookId })
  }

  if (name === 'notefast_search_more') {
    const q = (typeof args.query === 'string' && args.query.trim()) || fallbackQuery
    const notebookId = (typeof args.notebook_id === 'string' ? args.notebook_id : undefined) || ctx.notebookId
    const since = (typeof args.since === 'string' ? args.since : undefined) || ctx.since
    const until = (typeof args.until === 'string' ? args.until : undefined) || ctx.until
    const limit = typeof args.limit === 'number' ? Math.min(20, Math.max(1, args.limit)) : 5
    // since/until 必须是 ISO；模型常把技能文案里的「7d」塞进来，SQLite 字符串比较会静默空结果
    if (since && Number.isNaN(Date.parse(since))) {
      return {
        content: JSON.stringify({
          error: ctx.lang === 'en'
            ? `Invalid since "${since}". Pass an ISO date such as 2026-08-13 or 2026-08-13T00:00:00.000Z, not a duration like 7d.`
            : `无效的 since "${since}"。请传 ISO 日期（如 2026-08-13 或 2026-08-13T00:00:00.000Z），不要传 7d 这类时长。`,
        }),
        resultCount: 0,
      }
    }
    if (until && Number.isNaN(Date.parse(until))) {
      return {
        content: JSON.stringify({
          error: ctx.lang === 'en'
            ? `Invalid until "${until}". Pass an ISO date such as 2026-08-13 or 2026-08-13T00:00:00.000Z.`
            : `无效的 until "${until}"。请传 ISO 日期（如 2026-08-13 或 2026-08-13T00:00:00.000Z）。`,
        }),
        resultCount: 0,
      }
    }

    const report = await hybridSearch({
      query: q,
      notebookId,
      since,
      until,
      topK: limit,
      minScore: ctx.minScore,
      includeArchived: args.include_archived === true,
      // RAG 场景放宽多样性上限：同文档连续段落对回答有价值
      maxPerDoc: 3,
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
    // status 白名单校验：schema enum 只是给模型看的提示，执行层不做校验时
    // 漏传（默认 note 排除收集箱）或传非法值（如中文）都会静默返回空列表，
    // 模型据此误判「收集箱为空」。显式报错让 agent 自我纠正重试。
    const VALID_STATUS = ['note', 'inbox', 'archived', 'all'] as const
    const status = typeof args.status === 'string' ? args.status : 'note'
    if (!VALID_STATUS.includes(status as (typeof VALID_STATUS)[number])) {
      return {
        content: JSON.stringify({
          error: ctx.lang === 'en'
            ? `Invalid status "${status}". Valid values: note / inbox / archived / all. To list the inbox you must pass status="inbox" explicitly (default note excludes it).`
            : `无效的 status "${status}"。合法值：note / inbox / archived / all；查收集箱必须显式传 status="inbox"（默认 note 不含收集箱）。`,
        }),
        resultCount: 0,
      }
    }
    const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, args.limit)) : 20
    const staleRaw = typeof args.stale_within === 'string' ? args.stale_within.trim() : ''
    const updatedRaw = typeof args.updated_within === 'string' ? args.updated_within.trim() : ''
    const staleMs = staleRaw ? parseStaleWithin(staleRaw) : null
    const updatedMs = updatedRaw ? parseUpdatedWithin(updatedRaw) : null
    if (staleRaw && staleMs == null) {
      return {
        content: JSON.stringify({
          error: ctx.lang === 'en'
            ? `Invalid stale_within "${staleRaw}". Valid values: 30d / 90d.`
            : `无效的 stale_within "${staleRaw}"。合法值：30d / 90d。`,
        }),
        resultCount: 0,
      }
    }
    if (updatedRaw && updatedMs == null) {
      return {
        content: JSON.stringify({
          error: ctx.lang === 'en'
            ? `Invalid updated_within "${updatedRaw}". Valid values: 24h / 7d.`
            : `无效的 updated_within "${updatedRaw}"。合法值：24h / 7d。`,
        }),
        resultCount: 0,
      }
    }

    let rows = listDocRows(db)
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
    const docRow = getLiveDocById(db, docId)
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
    // 审计：agent 读了哪篇文档全文（含是否截断），便于事后追溯 LLM 接触过的内容
    emitAppEvent({
      source: 'system',
      actor: 'ai-agent',
      action: 'doc.read_by_agent',
      target: { type: 'doc', id: docId },
      outcome: 'success',
      durationMs: undefined,
      fields: { title: docRow.content, truncated, chars: markdown.length },
    })
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

  if (name === 'notefast_list_pinned_views') {
    const views = listPinnedViews()
    return { content: JSON.stringify({ views }), resultCount: views.length }
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
  const lang = opts.lang ?? 'zh'
  const hint = fixHint(lang)
  if (!hasRuntime()) {
    yield {
      type: 'error',
      error: {
        code: 'not_configured',
        message: lang === 'en' ? 'AI runtime not initialized' : 'AI runtime 未初始化',
        fix_hint: hint,
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
        message: lang === 'en' ? 'AI chat is not configured' : 'AI chat 未配置',
        fix_hint: hint,
      },
    }
    return
  }

  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user')
  const lastUserText = lastUser ? messageText(lastUser.content) : ''
  if (!lastUser || !lastUserText.trim()) {
    yield {
      type: 'error',
      error: { code: 'no_user_message', message: lang === 'en' ? 'No user message provided' : '未提供用户消息' },
    }
    return
  }

  // 消息中包含图片但视觉模型未启用：提前拒绝，避免透传到 provider 后返回晦涩错误
  const hasImagePart = opts.messages.some((m) =>
    Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
  )
  if (hasImagePart && !visionEnabled()) {
    yield {
      type: 'error',
      error: {
        code: 'llm_error',
        message: lang === 'en'
          ? 'The current model does not support image input. Enable vision in settings and configure a multimodal model.'
          : '当前模型不支持图片输入。请在设置中开启视觉（vision）能力并配置支持多模态的模型。',
      },
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
      // RAG 场景放宽多样性上限：同文档连续段落对回答有价值
      maxPerDoc: 3,
      // 首检索默认开查询理解：延迟摊进 chat 等待，失败则降级普通检索
      understandQuery: true,
      understandLang: lang,
    })
  } catch (e) {
    initialReport = {
      citations: [],
      retrieval: {
        fts_hits: 0,
        semantic_hits: 0,
        reranked: false,
        score_kind: 'rrf',
        timing: { understand_ms: 0, fts_ms: 0, embed_query_ms: 0, semantic_ms: 0, rerank_ms: 0, total_ms: 0 },
      },
    }
    console.error('[chat] retrieval failed:', e)
  }

  const currentDocTitle = opts.contextDocId ? lookupDocTitle(opts.contextDocId) : undefined
  let currentDocContent: string | undefined
  if (opts.contextDocId) {
    try {
      const docRows = fetchDocBlocks(getDb(), opts.contextDocId)
      if (docRows.length > 0) {
        const tree = buildBlockTree(docRows)
        currentDocContent = blocksToMarkdown(tree)
      }
    } catch { /* 加载失败不计较 */ }
  }
  const toolTrace: ToolTraceEntry[] = []
  const enableTools = opts.enableTools !== false
  const maxRounds = opts.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS
  const chatMaxTokens = opts.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS

  // ② 拼装 prompt（含 tool 定义）
  const promptMessages = buildChatPrompt({
    messages: opts.messages,
    citations: initialReport.citations,
    currentDocTitle,
    currentDocContent,
    lang,
    tools: enableTools ? getAllToolDefinitions(lang) : undefined,
  })

  yield { type: 'retrieval', report: initialReport }

  // ③ agent loop + 流式输出最终答案
  try {
    let workingMessages = promptMessages.slice()
    let finalCitations = initialReport.citations
    let finalRetrieval = initialReport.retrieval
    // 还剩几次「带工具的 LLM 轮」；用尽后只出文字，避免再要一轮写入却被静默丢掉
    let toolsLeft = enableTools ? maxRounds : 0

    for (let round = 0; round < maxRounds + 2; round++) {
      const allowTools = toolsLeft > 0
      if (!allowTools) {
        for await (const ev of emitStreamChunks(
          runtime.streamChat(workingMessages, {
            temperature: opts.temperature ?? 0.3,
            maxTokens: chatMaxTokens,
            signal: opts.signal,
          }),
        )) {
          yield ev
        }
        break
      }

      let toolCalls: ToolCall[] = []
      let streamFailed = false
      let streamError: unknown = null
      // 本轮是否已向客户端发出正文 token：已发出时降级路径不能再全量重发，
      // 否则客户端会拼出「半截答案 + 完整新答案」
      let sentTokens = false
      const llmStart = Date.now()
      try {
        const gen = emitStreamChunks(
          runtime.streamChatWithTools(workingMessages, {
            temperature: opts.temperature ?? 0.3,
            maxTokens: chatMaxTokens,
            tools: getAllToolDefinitions(lang),
            signal: opts.signal,
          }),
        )
        let next = await gen.next()
        while (!next.done) {
          if (next.value.type === 'token') sentTokens = true
          yield next.value
          next = await gen.next()
        }
        toolCalls = next.value
        console.info(JSON.stringify({
          event: 'llm_call',
          round,
          mode: 'stream_tools',
          tool_calls: toolCalls.length,
          tools_left: toolsLeft,
          duration_ms: Date.now() - llmStart,
        }))
      } catch (e) {
        console.error('[chat] streamChatWithTools failed, falling back:', e)
        streamFailed = true
        streamError = e
      }

      if (streamFailed) {
        let recovered = false
        if (typeof runtime.chatWithTools === 'function') {
          try {
            const result = await runtime.chatWithTools(workingMessages, {
              temperature: opts.temperature ?? 0.3,
              maxTokens: chatMaxTokens,
              tools: getAllToolDefinitions(lang),
              signal: opts.signal,
            })
            if (result && result.tool_calls.length > 0) {
              toolCalls = result.tool_calls
              recovered = true
            } else if (result && !sentTokens) {
              // 整包重发仅限「本轮还没发出任何 token」；已流过半截则落入下方错误收尾
              yield* emitCompleteAnswer(result.content || '', result.reasoning)
              break
            }
          } catch (e2) {
            console.error('[chat] chatWithTools fallback failed:', e2)
          }
        }
        if (!recovered && toolCalls.length === 0) {
          let answered = false
          if (!sentTokens) {
            // 未发出过 token：最后尝试纯流式重发完整答案
            try {
              for await (const ev of emitStreamChunks(
                runtime.streamChat(workingMessages, {
                  temperature: opts.temperature ?? 0.3,
                  maxTokens: chatMaxTokens,
                  signal: opts.signal,
                }),
              )) {
                if (ev.type === 'token') sentTokens = true
                yield ev
              }
              answered = true
            } catch (e2) {
              streamError = e2
            }
          }
          if (!answered) {
            // 半截答案已发出（不再全量重发防拼接）或全部降级失败：错误收尾。
            // done 不在此发送——统一由循环出口后的单次 done 收尾，避免双发
            const msg = streamError instanceof Error ? streamError.message : String(streamError)
            yield {
              type: 'error',
              error: {
                code: 'llm_error',
                message: `流式回答失败: ${msg}`,
              },
            }
          }
          break
        }
      }

      if (toolCalls.length > 0) {
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
          // 写工具直接执行（executeToolCall 内部路由到 executeWriteTool），
          // 不再发 write_proposal 等待用户确认——文档有 revision 历史，写错可回退。
          const exec = await executeToolCall(tc.name, tc.args, lastUserText, {
            notebookId: opts.notebookId,
            ctxDocId: opts.contextDocId,
            since: opts.since,
            until: opts.until,
            minScore: opts.minScore,
            lang,
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
        toolsLeft--
        continue
      }

      // 无 tool call：答案已在流中发出
      break
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
        fix_hint: code === 'not_configured' ? fixHint(lang) : undefined,
      },
    }
  }
}

function lookupDocTitle(docId: string): string | undefined {
  try {
    return getDocById(getDb(), docId)?.content
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
  writeProposals?: Array<{ tool: string; args: Record<string, unknown> }>
}> {
  let answer = ''
  let reasoning = ''
  let citations: Citation[] = []
  let retrieval: HybridSearchReport['retrieval'] = {
    fts_hits: 0,
    semantic_hits: 0,
    reranked: false,
    score_kind: 'rrf',
    timing: { understand_ms: 0, fts_ms: 0, embed_query_ms: 0, semantic_ms: 0, rerank_ms: 0, total_ms: 0 },
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
      const prefix = ev.error.code === 'not_configured' ? (opts.lang === 'en' ? '[not configured] ' : '[未配置] ') : ''
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
