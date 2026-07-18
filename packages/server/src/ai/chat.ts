/**
 * Chat 编排层
 *
 * 输入：用户的多轮对话 + 可选 doc hint
 * 输出：AsyncIterable<ChatEvent>，对应 Hono streamSSE 的事件流
 *
 *   event: retrieval  → 检索完成
 *   event: token      → 流式 token
 *   event: done       → 流结束（带 citations）
 *   event: error      → 出错
 *
 * 流程：
 *  1. hybridSearch() 拿 citations（embedding 不可用时降级到 FTS5）
 *  2. buildChatPrompt() 组装 prompt
 *  3. runtime.streamChat() 流式 LLM
 *  4. 把每个 delta 包成 token 事件；最后包成 done（含 citations）
 */

import type { ChatMessage } from '@notefast/core'
import type { Citation } from './hybridSearch'
import { getDb } from '../db'
import { expandBlockContext, hybridSearch, type HybridSearchReport } from './hybridSearch'
import { buildChatPrompt } from './prompt'
import { getRuntime, hasRuntime } from '../services/aiRuntime'

export type ChatEvent =
  | { type: 'retrieval'; report: HybridSearchReport }
  | { type: 'token'; content: string }
  | { type: 'done'; citations: Citation[]; retrieval: HybridSearchReport['retrieval'] }
  | { type: 'error'; error: ChatError }

export interface ChatError {
  code: 'not_configured' | 'no_user_message' | 'llm_error' | 'stream_error'
  message: string
  fix_hint?: string
}

export interface RunChatOptions {
  messages: ChatMessage[]
  contextDocId?: string
  topK?: number
  ftsLimit?: number
  semanticLimit?: number
  rerankWindow?: number
  temperature?: number
  maxTokens?: number
}

const FIX_HINT = '请在 Web UI /settings 页面配置 Chat 模型（API Key + Base URL + 模型名）'

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

  // ① 检索
  let report: HybridSearchReport
  try {
    report = await hybridSearch({
      query: lastUser.content,
      contextDocId: opts.contextDocId,
      topK: opts.topK,
      ftsLimit: opts.ftsLimit,
      semanticLimit: opts.semanticLimit,
      rerankWindow: opts.rerankWindow,
    })
  } catch (e) {
    report = { citations: [], retrieval: { fts_hits: 0, semantic_hits: 0, reranked: false } }
    console.warn('[chat] retrieval failed:', e instanceof Error ? e.message : e)
  }

  // 上下文补全：拉父 doc + 兄弟，写入 citation 的扩展元信息（可选；prompt 暂用 doc_title 即可）
  if (report.citations.length > 0) {
    expandBlockContext(report.citations.map((c) => c.block_id))
  }

  // ② 拼装 prompt
  const currentDocTitle = opts.contextDocId ? lookupDocTitle(opts.contextDocId) : undefined
  const promptMessages = buildChatPrompt({
    messages: opts.messages,
    citations: report.citations,
    currentDocTitle,
  })

  // ③ 流式 LLM
  yield { type: 'retrieval', report }

  try {
    for await (const chunk of runtime.streamChat(promptMessages, {
      temperature: opts.temperature ?? 0.3,
      maxTokens: opts.maxTokens ?? 2000,
    })) {
      if (chunk.content) yield { type: 'token', content: chunk.content }
      if (chunk.done) {
        yield {
          type: 'done',
          citations: report.citations,
          retrieval: report.retrieval,
        }
        return
      }
    }
    // 自然结束（无显式 done 事件兜底）
    yield {
      type: 'done',
      citations: report.citations,
      retrieval: report.retrieval,
    }
  } catch (e) {
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
  citations: Citation[]
  retrieval: HybridSearchReport['retrieval']
}> {
  let answer = ''
  let citations: Citation[] = []
  let retrieval: HybridSearchReport['retrieval'] = {
    fts_hits: 0,
    semantic_hits: 0,
    reranked: false,
  }

  for await (const ev of runChat(opts)) {
    if (ev.type === 'token') answer += ev.content
    else if (ev.type === 'done') {
      citations = ev.citations
      retrieval = ev.retrieval
    } else if (ev.type === 'error') {
      const prefix = ev.error.code === 'not_configured' ? '[未配置] ' : ''
      throw new Error(prefix + ev.error.message)
    }
  }
  return { answer, citations, retrieval }
}
