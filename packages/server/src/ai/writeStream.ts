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

import {
  buildWritePrompt,
  clipContinuePrefix,
  clipContinueSuffix,
  ThinkStreamParser,
  type WriteMode,
} from '@notefast/core'
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
  /** 选区前 / 光标前的附加上下文；refine 使用 */
  prefix?: string
  /** 光标后文本；continue 与 refine 均可使用 */
  suffix?: string
  temperature?: number
  maxTokens?: number
  /** 客户端断连信号：贯穿到上游 LLM 请求 */
  signal?: AbortSignal
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

  const content =
    opts.mode === 'continue' ? clipContinuePrefix(opts.content) : opts.content
  const suffix = opts.suffix ? clipContinueSuffix(opts.suffix) : undefined
  const prefix =
    opts.mode === 'refine' && opts.prefix ? clipContinuePrefix(opts.prefix) : undefined
  const messages = buildWritePrompt(opts.mode, content, {
    instruction: opts.instruction,
    targetLang: opts.targetLang,
    prefix,
    suffix,
  })

  try {
    // 与 chat.ts 同一套拆分：reasoning 独立字段天然不下发；
    // content 里内嵌的 <think> 块（部分推理模型/代理会合进正文）经流式拆分剔除，
    // 否则思考过程会被当作改写/续写结果写回编辑器
    const thinkParser = new ThinkStreamParser()
    // think 块与正文之间的分隔换行（"</think>\n\n"）会被拆分器计入正文，
    // 缓冲到首个非空白字符再下发，剥掉这段前导空白
    let buffered = ''
    let contentStarted = false
    const takeContent = (s: string): string => {
      if (contentStarted) return s
      buffered += s
      if (!/\S/.test(buffered)) return ''
      contentStarted = true
      const out = buffered.replace(/^\s+/, '')
      buffered = ''
      return out
    }
    for await (const chunk of runtime.streamChat(messages, {
      temperature: opts.temperature ?? 0.4,
      maxTokens: opts.maxTokens ?? (opts.mode === 'continue' ? 384 : 1024),
      signal: opts.signal,
    })) {
      if (chunk.content) {
        const out = takeContent(thinkParser.push(chunk.content).content)
        if (out) yield { type: 'token', content: out }
      }
    }
    const tail = takeContent(thinkParser.flush().content)
    if (tail) yield { type: 'token', content: tail }
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
