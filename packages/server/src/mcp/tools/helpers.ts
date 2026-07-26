/**
 * MCP 工具共享 helper
 *
 * 原 mcp/tools.ts 顶部 ~150 行的公共部分：统一错误语义、ai_exclude 守卫、
 * 文档行过滤、调用日志包裹与树工具。四个工具组（docRead / docWrite /
 * aiChat / autoLink）共用，避免重复拷贝。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  docMatchesTags,
  isDocInbox,
  isDocArchived,
  parseUpdatedWithin,
  readDocStatus,
  readTags,
  type Block,
  type BlockRow,
  type TagMatchMode,
} from '@notefast/core'
import { getDb } from '../../db'
import {
  isBlockAiExcluded,
  isDocAiExcluded,
  isDocRowAiExcluded,
} from '../../ai/aiExcludeQuery'

export type Db = ReturnType<typeof getDb>

export function toText(data: unknown): { type: 'text'; text: string } {
  return { type: 'text' as const, text: JSON.stringify(data, null, 2) }
}

// ───────────────────── 统一错误语义 ─────────────────────
// 所有 notefast_* 工具的错误一律：isError: true + { error: { code, message, data? } }。
// 客户端用 isError 判断成败、error.code 判断类型，不再解析自由文本。
// code 一览：
//   not_found       资源不存在（doc / block / notebook / suggestion）
//   invalid_params  参数语义非法（zod 管形状，这里管语义，如 since 格式、空 messages）
//   not_configured  AI Provider 未配置（带 fix_hint）
//   provider_error  LLM / embedding provider 调用失败（HTTP 错误、超时等）
//   llm_error       LLM 返回内容层面的失败（解析失败等）
//   internal        未预期的内部错误
export type ToolErrorCode =
  | 'not_found'
  | 'invalid_params'
  | 'not_configured'
  | 'provider_error'
  | 'llm_error'
  | 'forbidden'
  | 'internal'

export function toolError(
  code: ToolErrorCode,
  message: string,
  data?: Record<string, unknown>,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [toText({ error: { code, message, ...(data ? { data } : {}) } })],
    isError: true as const,
  }
}

export function denyAiExcludedDoc(docId: string) {
  if (isDocAiExcluded(docId)) {
    return toolError('forbidden', `文档 ${docId} 已对 AI 隐藏，MCP 不可访问`, { doc_id: docId })
  }
  return null
}

export function denyAiExcludedBlock(blockId: string) {
  if (isBlockAiExcluded(blockId)) {
    return toolError('forbidden', `该内容所属文档已对 AI 隐藏，MCP 不可访问`, { block_id: blockId })
  }
  return null
}

export function filterDocRowsForMcp(rows: BlockRow[], opts: {
  tags?: string[]
  tagMatch?: TagMatchMode
  untagged?: boolean
  updatedWithin?: string | null
  /** 默认 note：排除收集箱与归档；inbox / archived / all 见 parseDocStatusFilter */
  status?: 'note' | 'inbox' | 'archived' | 'all'
}): BlockRow[] {
  let out = rows.filter((r) => !isDocRowAiExcluded(r))
  const statusFilter = opts.status ?? 'note'
  if (statusFilter === 'inbox') {
    out = out.filter((r) => isDocInbox(r))
  } else if (statusFilter === 'archived') {
    out = out.filter((r) => isDocArchived(r))
  } else if (statusFilter === 'note') {
    out = out.filter((r) => readDocStatus(r) === 'note')
  }
  if (opts.untagged) {
    out = out.filter((r) => readTags(r).length === 0)
  } else if (opts.tags && opts.tags.length > 0) {
    const mode = opts.tagMatch ?? 'all'
    out = out.filter((r) => docMatchesTags(readTags(r), opts.tags!, mode))
  }
  const withinMs = parseUpdatedWithin(opts.updatedWithin ?? undefined)
  if (withinMs != null) {
    const cutoff = Date.now() - withinMs
    out = out.filter((r) => {
      const ts = new Date(r.updated_at).getTime()
      return Number.isFinite(ts) && ts >= cutoff
    })
  }
  return out
}

export const NOT_CONFIGURED_HINT = '请在 Web UI /settings 页面配置 AI Provider'

export function validateNotebook(database: Db, notebookId: string) {
  const exists = database.query('SELECT id FROM notebooks WHERE id = ?').get(notebookId)
  if (!exists) {
    return toolError('not_found', `笔记本 ${notebookId} 不存在`, { notebook_id: notebookId })
  }
  return null
}

/** ISO 时间字符串语义校验；合法返回 true */
export function isValidIsoDate(s: string): boolean {
  return !Number.isNaN(Date.parse(s))
}

// ───────────────────── 调用日志 ─────────────────────
// 单行 JSON，便于容器 stdout 采集：谁、调了什么、花了多久、成败。
// 不引第三方日志库，保持依赖最小。

function logJson(level: 'info' | 'error', data: Record<string, unknown>): void {
  const line = JSON.stringify(data)
  if (level === 'error') console.error(line)
  else console.info(line)
}

/** 包裹 tool handler：记录 tool_call 事件（isError: true 记为 error 状态） */
export function withToolLogging<A, R>(name: string, handler: (args: A) => Promise<R>): (args: A) => Promise<R> {
  return (async (args: A) => {
    const start = Date.now()
    try {
      const result = await handler(args)
      const isErr = typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError === true
      logJson('info', { event: 'tool_call', tool: name, duration_ms: Date.now() - start, status: isErr ? 'error' : 'ok' })
      return result
    } catch (e) {
      logJson('error', {
        event: 'tool_call',
        tool: name,
        duration_ms: Date.now() - start,
        status: 'exception',
        error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  }) as (args: A) => Promise<R>
}

/** 已包日志的 registerTool（与原 tools.ts 内联包装一致） */
export type RegisterToolFn = McpServer['registerTool']

/** 统一在注册处包一层日志，避免逐个 handler 手动包裹 */
export function createRegisterTool(server: McpServer): RegisterToolFn {
  return ((name: string, config: unknown, handler: (args: never) => Promise<unknown>) =>
    server.registerTool(name, config as never, withToolLogging(name, handler) as never)) as RegisterToolFn
}

/** 工具组注册上下文：server + db + 默认 notebook + 包日志的 registerTool */
export interface ToolContext {
  server: McpServer
  db: Db
  notebookId: string
  registerTool: RegisterToolFn
}

// ───────────────────── 树工具 ─────────────────────

export function limitTreeDepth(block: Block, maxDepth: number): Block {
  return {
    ...block,
    children: block.children.map((c) => {
      const childBlock = { ...c }
      if (childBlock.level >= maxDepth) {
        childBlock.children = []
      } else {
        childBlock.children = childBlock.children.map((gc) => limitTreeDepth(gc, maxDepth))
      }
      return childBlock
    }),
  }
}

export function extractHeadings(rows: BlockRow[]): { id: string; content: string; level: number }[] {
  return rows
    .filter((r) => r.type === 'heading')
    .map((r) => {
      let props: Record<string, unknown> = {}
      try { props = JSON.parse(r.properties) } catch { /* ignore */ }
      return {
        id: r.id,
        content: r.content,
        level: (props.headingLevel as number) || 1,
      }
    })
}
