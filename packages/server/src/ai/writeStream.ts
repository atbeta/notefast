/**
 * AI 写作 SSE 流生成器
 *
 * 输入：mode + content + 可选参数
 * 输出：AsyncGenerator<{ type: 'token' | 'done' | 'error', ... }>
 *
 * 与 chat.ts 的差异：
 * - 不涉及 RAG / hybrid search / agent loop
 * - 纯 LLM 续写 / 润色 / 翻译等
 * - 输出直接回填编辑器，不需要引用
 */

import { buildWritePrompt, type WriteMode } from '@notefast/core'
import { getRuntime, hasRuntime } from '../services/aiRuntime'

export interface WriteEvent {
  type: 'token' | 'done' | 'error'
  content?: string
  error?: { code: string; message: string }
}

export interface WriteOptions {
  mode: WriteMode
  content: string
  instruction?: string
  targetLang?: string
  temperature?: number
  maxTokens?: number
}

const MODE_LABELS: Record<WriteMode, string> = {
  continue: '续写',
  refine: '改写',
  translate: '翻译',
  summarize: '总结',
  expand: '扩写',
  shorten: '缩写',
}

export async function* streamWrite(opts: WriteOptions): AsyncGenerator<WriteEvent> {
  if (!hasRuntime()) {
    yield { type: 'error', error: { code: 'not_configured', message: 'AI runtime 未初始化' } }
    return
  }
  const runtime = getRuntime()
  if (!runtime.hasChat()) {
    yield { type: 'error', error: { code: 'not_configured', message: 'Chat 模型未配置' } }
    return
  }

  const messages = buildWritePrompt(opts.mode, opts.content, {
    instruction: opts.instruction,
    targetLang: opts.targetLang,
  })

  try {
    for await (const chunk of runtime.streamChat(messages, {
      temperature: opts.temperature ?? 0.4,
      maxTokens: opts.maxTokens ?? 1024,
    })) {
      if (chunk.content) yield { type: 'token', content: chunk.content }
    }
    yield { type: 'done' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    yield {
      type: 'error',
      error: {
        code: msg.includes('not configured') ? 'not_configured' : 'llm_error',
        message: `AI ${MODE_LABELS[opts.mode]}失败: ${msg}`,
      },
    }
  }
}
