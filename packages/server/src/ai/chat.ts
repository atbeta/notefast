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

import type { ChatMessage, ToolCall, ToolDefinition } from '@notefast/core'
import { ThinkStreamParser, splitThinkContent } from '@notefast/core'
import type { Citation } from './hybridSearch'
import { getDb } from '../db'
import { hybridSearch, type HybridSearchReport } from './hybridSearch'
import { buildChatPrompt } from './prompt'
import { getRuntime, hasRuntime } from '../services/aiRuntime'

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
        '用不同的关键词、缩小范围、加时间窗等条件重新检索知识库。当初始结果不够、用户问得更具体、或需要时间维度（"上周写过什么"）时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '新关键词；留空则用当前对话最后一条 user 消息' },
          notebook_id: { type: 'string', description: '限定到某个 notebook（可选）' },
          since: { type: 'string', description: 'ISO 时间字符串，只返回 blocks.updated_at >= since 的块' },
          until: { type: 'string', description: 'ISO 时间字符串，只返回 blocks.updated_at <= until 的块' },
          limit: { type: 'number', description: '返回的引用数量（1-20）', default: 5 },
        },
      },
    },
  }
}

/**
 * 执行 LLM 请求的工具调用。
 * 当前只支持 notefast_search_more；其它工具返回空结果，避免 LLM 调用未实现的工具。
 */
async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  fallbackQuery: string,
  ctx: { notebookId?: string; since?: string; until?: string; minScore?: number },
): Promise<{ citations: Citation[]; retrieval: HybridSearchReport['retrieval']; resultCount: number }> {
  if (name !== 'notefast_search_more') {
    return {
      citations: [],
      retrieval: { fts_hits: 0, semantic_hits: 0, reranked: false },
      resultCount: 0,
    }
  }
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
  })
  return { citations: report.citations, retrieval: report.retrieval, resultCount: report.citations.length }
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
  if (!lastUser || !lastUser.content.trim()) {
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
      query: lastUser.content,
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
    initialReport = { citations: [], retrieval: { fts_hits: 0, semantic_hits: 0, reranked: false } }
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
    tools: enableTools ? [getSearchToolDefinition()] : undefined,
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
              tools: [getSearchToolDefinition()],
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
                tools: [getSearchToolDefinition()],
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
            const exec = await executeToolCall(tc.name, tc.args, lastUser.content, {
              notebookId: opts.notebookId,
              since: opts.since,
              until: opts.until,
              minScore: opts.minScore,
            })
            toolTrace.push({
              tool: tc.name,
              args: tc.args,
              result_count: exec.resultCount,
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
              content: JSON.stringify({
                citations: exec.citations.map((c) => ({
                  block_id: c.block_id,
                  doc_id: c.doc_id,
                  doc_title: c.doc_title,
                  snippet: c.snippet,
                  score: c.score,
                })),
                retrieval: exec.retrieval,
              }),
            })

            if (exec.citations.length > 0) {
              finalCitations = exec.citations
              finalRetrieval = exec.retrieval
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
