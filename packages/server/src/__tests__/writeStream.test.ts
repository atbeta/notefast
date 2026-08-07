/**
 * /ai/write 流式生成的 think 剥离测试：
 * 推理模型把 <think> 块内嵌进 content（或走 reasoning_content 独立字段）时，
 * 思考过程不得作为 token 下发（否则会被当作改写/续写结果写回编辑器）。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb } from '../db'
import { createPluginSystem } from '@notefast/core'
import {
  initAiRuntime,
  applyNewConfig,
  _setRuntimeForTests,
  getRuntime,
} from '../services/aiRuntime'
import { streamWrite, type WriteEvent } from '../ai/writeStream'

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-write-'))
  initDb(testDir)
})

afterAll(() => {
  // 不泄漏带 mock fetch 的 AI runtime 给其他测试文件（bun 跨文件共享模块状态）
  _setRuntimeForTests(null)
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

const encoder = new TextEncoder()

function sseResponse(chunks: string[]): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(encoder.encode(ch))
        c.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

/** 配置 mock chat provider 并把全局 fetch 换成按帧回放 SSE 的假货 */
function mockChatStream(frames: string[]): void {
  const pluginSystem = createPluginSystem()
  initAiRuntime(pluginSystem, testDir)
  applyNewConfig(
    {
      version: 1,
      chat: {
        id: 'x',
        label: 'x',
        preset: 'custom',
        baseUrl: 'http://mock',
        apiKey: '',
        embeddingModel: '',
        chatModel: 'fake-chat',
        timeoutMs: 5000,
        extraHeaders: {},
      },
      embedding: null,
      autoIndex: false,
      reranker: null,
    },
    pluginSystem,
  )
  getRuntime().setFetchImpl((async () => sseResponse(frames)) as unknown as typeof fetch)
}

async function collect(events: AsyncGenerator<WriteEvent>): Promise<WriteEvent[]> {
  const out: WriteEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

function tokenText(events: WriteEvent[]): string {
  return events.filter((e) => e.type === 'token').map((e) => e.content ?? '').join('')
}

describe('streamWrite — think 内容剥离', () => {
  beforeEach(() => {
    _setRuntimeForTests(null)
    const configPath = join(testDir, 'ai.config.json')
    if (existsSync(configPath)) unlinkSync(configPath)
  })

  test('正文内嵌 <think> 块（跨帧边界）不下发', async () => {
    mockChatStream([
      'data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"nk>先分析一下原文。"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"风格要保持。</thi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"nk>\\n\\n"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"润色后的"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"正文"}}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const events = await collect(streamWrite({ mode: 'refine', content: '原文' }))
    expect(tokenText(events)).toBe('润色后的正文')
    expect(events.at(-1)?.type).toBe('done')
  })

  test('reasoning_content 独立字段不下发', async () => {
    mockChatStream([
      'data: {"choices":[{"delta":{"reasoning_content":"思考中…"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"正文"}}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const events = await collect(streamWrite({ mode: 'continue', content: '上文' }))
    expect(tokenText(events)).toBe('正文')
  })

  test('未闭合 <think>（截断）尾帧冲刷时不漏进正文', async () => {
    mockChatStream([
      'data: {"choices":[{"delta":{"content":"有效开头"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"<think>中途开始思考且没有闭合"}}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const events = await collect(streamWrite({ mode: 'continue', content: '上文' }))
    expect(tokenText(events)).toBe('有效开头')
  })

  test('纯文本无标签时原样透传', async () => {
    mockChatStream([
      'data: {"choices":[{"delta":{"content":"第一"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"第二"}}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const events = await collect(streamWrite({ mode: 'continue', content: '上文' }))
    expect(tokenText(events)).toBe('第一第二')
    expect(events.at(-1)?.type).toBe('done')
  })
})
