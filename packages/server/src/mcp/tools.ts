import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getDb } from '../db'
import {
  buildBlockTree,
  buildFtsQuery,
  highlightSnippet,
  blocksToMarkdown,
  parseMarkdownToBlocks,
  rowToBlock,
  suggestTitle,
  type LLMProvider,
  type ChatMessage,
} from '@notefast/core'
import type { BlockRow } from '@notefast/core'
import { hasRuntime, getRuntime } from '../services/aiRuntime'
import { semanticSearch } from '../ai/indexer'
import { runChatSync } from '../ai/chat'
import {
  applySuggestion,
  dismissSuggestion,
  listSuggestions,
  revertSuggestion,
  toWire,
} from '../ai/autoLinkStore'
import {
  analyzeBlock,
} from '../ai/autoLink'
import { fireAfterCreate, fireAfterUpdate, fireAfterCreateMany } from '../services/hooks'

function toText(data: unknown): { type: 'text'; text: string } {
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
  | 'internal'

function toolError(
  code: ToolErrorCode,
  message: string,
  data?: Record<string, unknown>,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [toText({ error: { code, message, ...(data ? { data } : {}) } })],
    isError: true as const,
  }
}

const NOT_CONFIGURED_HINT = '请在 Web UI /settings 页面配置 AI Provider'

function validateNotebook(database: ReturnType<typeof getDb>, notebookId: string) {
  const exists = database.query('SELECT id FROM notebooks WHERE id = ?').get(notebookId)
  if (!exists) {
    return toolError('not_found', `笔记本 ${notebookId} 不存在`, { notebook_id: notebookId })
  }
  return null
}

/** ISO 时间字符串语义校验；合法返回 true */
function isValidIsoDate(s: string): boolean {
  return !Number.isNaN(Date.parse(s))
}

export function registerMcpTools(server: McpServer, notebookId: string): void {
  const db = getDb()

  server.registerTool(
    'notefast_search',
    {
      description: '全文搜索知识库，返回匹配的 block 列表',
      inputSchema: {
        query: z.string().describe('搜索关键词'),
        notebook_id: z.string().optional().describe('限定笔记本 ID'),
        limit: z.number().optional().default(10).describe('最大返回数量'),
      },
    },
    async ({ query, notebook_id, limit }) => {
      const { query: ftsQuery } = buildFtsQuery(query, limit)

      let sql = `
        SELECT b.*, rank FROM blocks_fts f
        JOIN blocks b ON b.id = f.id
        WHERE blocks_fts MATCH ?`
      const params: (string | number)[] = [ftsQuery]

      if (notebook_id) {
        sql += ' AND b.notebook_id = ?'
        params.push(notebook_id)
      }

      sql += ' ORDER BY rank LIMIT ?'
      params.push(limit as number)

      const rows = db.query(sql).all(...params as [string, ...(string | number)[]]) as (BlockRow & { rank: number })[]

      return {
        content: [toText(rows.map((r) => ({
          block_id: r.id,
          type: r.type,
          content: r.content,
          snippet: highlightSnippet(r.content, query),
          rank: r.rank,
        })))],
      }
    },
  )

  server.registerTool(
    'notefast_get_doc',
    {
      description: '获取文档完整内容（block 树）',
      inputSchema: {
        doc_id: z.string().describe('文档 ID'),
        depth: z.number().optional().default(5).describe('子块深度限制'),
      },
    },
    async ({ doc_id, depth }) => {
      const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(doc_id, 'document') as BlockRow | undefined
      if (!docRow) {
        return toolError('not_found', `文档 ${doc_id} 不存在`, { doc_id })
      }

      const rows = fetchDescendants(db, doc_id)
      const allRows = [docRow, ...rows]
      const tree = buildBlockTree(allRows)

      return {
        content: [toText({
          doc: tree.length > 0 ? limitTreeDepth(tree[0], depth ?? 5) : null,
          block_count: allRows.length,
        })],
      }
    },
  )

  server.registerTool(
    'notefast_get_block',
    {
      description: '获取单个 block 及其上下文',
      inputSchema: {
        block_id: z.string().describe('Block ID'),
      },
    },
    async ({ block_id }) => {
      const row = db.query('SELECT * FROM blocks WHERE id = ?').get(block_id) as BlockRow | undefined
      if (!row) {
        return toolError('not_found', `Block ${block_id} 不存在`, { block_id })
      }

      const block = rowToBlock(row)

      const children = db.query('SELECT * FROM blocks WHERE parent_id = ? ORDER BY sort ASC').all(block_id) as BlockRow[]
      block.children = buildBlockTree(children)

      const parentPath: { id: string; content: string; type: string }[] = []
      let currentId = row.parent_id
      while (currentId) {
        const parent = db.query('SELECT id, content, type, parent_id FROM blocks WHERE id = ?').get(currentId) as
          | { id: string; content: string; type: string; parent_id: string | null }
          | undefined
        if (!parent) break
        parentPath.unshift({ id: parent.id, content: parent.content, type: parent.type })
        currentId = parent.parent_id
      }

      const refs = db
        .query(
          `SELECT r.id, r.source_id, r.target_id, r.ref_type, r.created_at,
                  b.content as source_content
           FROM block_refs r
           JOIN blocks b ON b.id = r.source_id
           WHERE r.target_id = ?
           ORDER BY r.created_at DESC LIMIT 10`,
        )
        .all(block_id) as { id: number; source_id: string; target_id: string; ref_type: string; created_at: string; source_content: string }[]

      return {
        content: [toText({
          block,
          parent_path: parentPath,
          backlinks_count: refs.length,
          backlinks: refs.map((r) => ({ source_id: r.source_id, source_content: r.source_content })),
        })],
      }
    },
  )

  server.registerTool(
    'notefast_create_block',
    {
      description: '创建新 block',
      inputSchema: {
        notebook_id: z.string().optional().describe('笔记本 ID，默认使用默认笔记本'),
        parent_id: z.string().optional().describe('父 block ID'),
        type: z.enum(['heading', 'paragraph', 'list', 'list_item', 'code', 'quote', 'table']).describe('块类型'),
        content: z.string().max(500_000).describe('块内容（Markdown 格式）'),
      },
    },
    async ({ notebook_id, parent_id, type, content }) => {
      const nid = notebook_id || notebookId
      const nbErr = validateNotebook(db, nid)
      if (nbErr) return { content: [toText(nbErr)] }

      const id = crypto.randomUUID()

      let rootId: string
      let level = 0

      if (parent_id) {
        const parent = db.query('SELECT root_id, level FROM blocks WHERE id = ?').get(parent_id) as
          | { root_id: string; level: number }
          | undefined
        if (!parent) {
          return toolError('not_found', `父块 ${parent_id} 不存在`, { parent_id })
        }
        rootId = parent.root_id
        level = parent.level + 1
      } else {
        rootId = id
      }

      const now = new Date().toISOString()
      db.query(
        `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(id, nid, parent_id || null, rootId, type, content, level, now, now)

      const row = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow
      fireAfterCreate(rowToBlock(row))
      return { content: [toText({ block: rowToBlock(row) })] }
    },
  )

  server.registerTool(
    'notefast_update_block',
    {
      description: '更新 block 内容',
      inputSchema: {
        block_id: z.string().describe('Block ID'),
        content: z.string().max(500_000).describe('新内容（Markdown 格式）'),
      },
    },
    async ({ block_id, content }) => {
      const existing = db.query('SELECT * FROM blocks WHERE id = ?').get(block_id)
      if (!existing) {
        return toolError('not_found', `Block ${block_id} 不存在`, { block_id })
      }

      db.query("UPDATE blocks SET content = ?, updated_at = datetime('now') WHERE id = ?").run(content, block_id)

      const row = db.query('SELECT * FROM blocks WHERE id = ?').get(block_id) as BlockRow
      fireAfterUpdate(rowToBlock(row))
      return { content: [toText({ block: rowToBlock(row) })] }
    },
  )

  server.registerTool(
    'notefast_create_doc',
    {
      description: '从 Markdown 创建文档',
      inputSchema: {
        notebook_id: z.string().optional().describe('笔记本 ID，默认使用默认笔记本'),
        title: z.string().describe('文档标题'),
        markdown: z.string().describe('Markdown 内容'),
      },
    },
    async ({ notebook_id, title, markdown }) => {
      const nid = notebook_id || notebookId
      const nbErr = validateNotebook(db, nid)
      if (nbErr) return { content: [toText(nbErr)] }

      const inputs = parseMarkdownToBlocks(markdown, nid)
      const docId = crypto.randomUUID()
      const now = new Date().toISOString()
      const insertedIds: string[] = []
      // inp.id → 实际 blockId 映射表；父对子的引用必须走这条映射。
      // 否则 inp.parent_id 指向 parseMarkdownToBlocks 产生的临时 UUID
      // （从未 INSERT），嵌套块（代码块/子列表等）会触发 immediate FK 失败。
      const idMap = new Map<string, string>()

      db.transaction(() => {
        // 安全网：PRAGMA 作用域限本事务，提交时检查 FK，避免 immediate 阶段炸开
        db.run('PRAGMA defer_foreign_keys = ON')

        db.query(
          `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
           VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
        ).run(docId, nid, docId, title, now, now)

        for (const inp of inputs) {
          const blockId = crypto.randomUUID()
          // 父链映射：从临时 id 翻译成已经 INSERT 的实际 id
          const parentId = inp.parent_id
            ? (idMap.get(inp.parent_id) ?? docId)
            : docId
          if (inp.id) idMap.set(inp.id, blockId)

          db.query(
            `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, sort, level, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
          ).run(
            blockId,
            nid,
            parentId as string,
            docId,
            inp.type,
            inp.content ?? '',
            JSON.stringify(inp.properties || {}),
            now,
            now,
          )
          insertedIds.push(blockId)
        }
      })()

      // Hook 触发（fire-and-forget）：先 doc，再批量子块
      const docRow = db.query('SELECT * FROM blocks WHERE id = ?').get(docId) as BlockRow
      fireAfterCreate(rowToBlock(docRow))
      if (insertedIds.length > 0) {
        const placeholders = insertedIds.map(() => '?').join(',')
        const childRows = db
          .query(`SELECT * FROM blocks WHERE id IN (${placeholders})`)
          .all(...insertedIds) as BlockRow[]
        fireAfterCreateMany(childRows.map(rowToBlock))
      }

      return {
        content: [toText({
          doc_id: docId,
          title,
          block_count: inputs.length + 1,
        })],
      }
    },
  )

  server.registerTool(
    'notefast_get_backlinks',
    {
      description: '获取反向链接（引用此 block 的 block 列表）',
      inputSchema: {
        block_id: z.string().describe('Block ID'),
      },
    },
    async ({ block_id }) => {
      // 目标 block 不存在时也要报 not_found，而不是返回空列表（调用方无法区分「没有反链」和「id 错了」）
      const target = db.query('SELECT id FROM blocks WHERE id = ?').get(block_id)
      if (!target) {
        return toolError('not_found', `Block ${block_id} 不存在`, { block_id })
      }
      const refs = db
        .query(
          `SELECT r.id, r.source_id, r.target_id, r.ref_type, r.created_at,
                  b.content as source_content, b.type as source_type
           FROM block_refs r
           JOIN blocks b ON b.id = r.source_id
           WHERE r.target_id = ?
           ORDER BY r.created_at DESC`,
        )
        .all(block_id) as { id: number; source_id: string; target_id: string; ref_type: string; created_at: string; source_content: string; source_type: string }[]

      return {
        content: [toText({
          target_id: block_id,
          backlinks_count: refs.length,
          backlinks: refs.map((r) => ({
            source_id: r.source_id,
            source_content: r.source_content,
            source_type: r.source_type,
            ref_type: r.ref_type,
          })),
        })],
      }
    },
  )

  server.registerTool(
    'notefast_list_docs',
    {
      description: '列出文档列表',
      inputSchema: {
        notebook_id: z.string().optional().describe('笔记本 ID，默认使用默认笔记本'),
      },
    },
    async ({ notebook_id }) => {
      const nid = notebook_id || notebookId

      const rows = db
        .query('SELECT * FROM blocks WHERE type = ? AND notebook_id = ? ORDER BY updated_at DESC')
        .all('document', nid) as BlockRow[]

      return {
        content: [toText({
          notebook_id: nid,
          doc_count: rows.length,
          docs: rows.map((r) => ({
            id: r.id,
            title: r.content,
            created_at: r.created_at,
            updated_at: r.updated_at,
          })),
        })],
      }
    },
  )

  server.registerTool(
    'notefast_get_doc_tree',
    {
      description: '获取文档大纲（仅 heading 层级）',
      inputSchema: {
        doc_id: z.string().describe('文档 ID'),
      },
    },
    async ({ doc_id }) => {
      const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(doc_id, 'document') as BlockRow | undefined
      if (!docRow) {
        return toolError('not_found', `文档 ${doc_id} 不存在`, { doc_id })
      }

      const rows = fetchDescendants(db, doc_id)
      const headings = extractHeadings([docRow, ...rows])

      return {
        content: [toText({
          doc_id,
          doc_title: docRow.content,
          headings,
        })],
      }
    },
  )

  server.registerTool(
    'notefast_export_markdown',
    {
      description: '导出文档为 Markdown',
      inputSchema: {
        doc_id: z.string().describe('文档 ID'),
      },
    },
    async ({ doc_id }) => {
      const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(doc_id, 'document') as BlockRow | undefined
      if (!docRow) {
        return toolError('not_found', `文档 ${doc_id} 不存在`, { doc_id })
      }

      const rows = fetchDescendants(db, doc_id)
      const allRows = [docRow, ...rows]
      const tree = buildBlockTree(allRows)
      const markdown = blocksToMarkdown(tree)

      return { content: [toText({ doc_id, markdown })] }
    },
  )

  server.registerTool(
    'notefast_semantic_search',
    {
      description: '语义搜索知识库（需配置 AI Provider），用自然语言查找最相关的 block',
      inputSchema: {
        query: z.string().describe('自然语言查询，如 "关于 React 性能优化我写过什么"'),
        limit: z.number().optional().default(10).describe('最大返回数量'),
        notebook_id: z.string().optional().describe('限定笔记本 ID'),
      },
    },
    async ({ query, limit, notebook_id }) => {
      if (!hasRuntime() || !getRuntime().hasEmbedding()) {
        return toolError('not_configured', 'Embedding 模型未配置', { fix_hint: NOT_CONFIGURED_HINT })
      }
      try {
        const r = getRuntime()
        const vector = await r.embedQuery(query)
        if (!vector) {
          return toolError('provider_error', r.status().embedding.lastError || 'embedding 返回空向量')
        }
        const hits = semanticSearch(vector, limit ?? 10, notebook_id)
        return { content: [toText({ query, results: hits.length, hits })] }
      } catch (e) {
        return toolError('provider_error', e instanceof Error ? e.message : String(e), { fix_hint: '请检查 /settings 中的 Provider 配置' })
      }
    },
  )

  server.registerTool(
    'notefast_suggest_title',
    {
      description: '根据笔记内容 AI 生成标题和摘要',
      inputSchema: {
        content: z.string().describe('笔记正文内容'),
      },
    },
    async ({ content }) => {
      if (!hasRuntime() || !getRuntime().hasChat()) {
        return toolError('not_configured', 'Chat 模型未配置', { fix_hint: NOT_CONFIGURED_HINT })
      }
      try {
        const r = getRuntime()
        const provider: LLMProvider = {
          name: 'notefast-runtime',
          chat: (msgs, opts) => r.chat(msgs, opts),
        }
        const result = await suggestTitle(provider, content)
        return { content: [toText(result)] }
      } catch (e) {
        return toolError('llm_error', e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.registerTool(
    'notefast_chat',
    {
      description:
        '与用户知识库对话：FTS5 + 语义检索 + 可选 reranker，再交给 LLM 生成带 [n] 引用的回答。LLM 可在 agent loop 中调用 notefast_search_more 重新检索（最多 3 轮）。返回完整 answer、citations 列表、retrieval 统计和 tool 轨迹。',
      inputSchema: {
        messages: z
          .array(
            z.object({
              role: z.enum(['system', 'user', 'assistant']),
              content: z.string(),
            }),
          )
          .describe('对话历史（最后一条必须是 user）'),
        context_doc_id: z.string().optional().describe('当前查看文档 ID（hint 提升该 doc 的优先级）'),
        notebook_id: z.string().optional().describe('限定到某个 notebook'),
        since: z.string().optional().describe('ISO 时间字符串，只返回 blocks.updated_at >= since 的块'),
        until: z.string().optional().describe('ISO 时间字符串，只返回 blocks.updated_at <= until 的块'),
        top_k: z.number().int().min(1).max(20).optional().default(5).describe('返回引用数量（上限；少于此数说明相关结果不足）'),
        min_score: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('引用相关性最低分：低于此分的引用被过滤（数量计入 retrieval.discarded_low_score）。注意 scale：未配 reranker 时 score 是 RRF 分（~0.016-0.033），配了是 0.5-1 归一分'),
        temperature: z.number().min(0).max(2).optional().default(0.3),
        max_tokens: z.number().int().min(16).max(8000).optional().default(2000),
      },
    },
    async ({ messages, context_doc_id, notebook_id, since, until, top_k, min_score, temperature, max_tokens }) => {
      // 语义校验（zod 只管形状）：空 messages / 最后一条非 user → invalid_params
      if (messages.length === 0 || messages[messages.length - 1]!.role !== 'user') {
        return toolError('invalid_params', 'messages 不能为空，且最后一条必须是 role=user', { path: 'messages' })
      }
      if (since && !isValidIsoDate(since)) {
        return toolError('invalid_params', `since 不是合法的 ISO 时间：${since}`, { path: 'since', value: since })
      }
      if (until && !isValidIsoDate(until)) {
        return toolError('invalid_params', `until 不是合法的 ISO 时间：${until}`, { path: 'until', value: until })
      }
      // context_doc_id 不存在时显式报错，而不是静默降级（调用方应知道 id 已失效）
      if (context_doc_id) {
        const ctx = db.query("SELECT id FROM blocks WHERE id = ? AND type = 'document'").get(context_doc_id)
        if (!ctx) {
          return toolError('not_found', `context_doc_id 指向的文档不存在：${context_doc_id}`, { context_doc_id })
        }
      }
      if (!hasRuntime() || !getRuntime().hasChat()) {
        return toolError('not_configured', 'Chat 模型未配置', { fix_hint: NOT_CONFIGURED_HINT })
      }
      try {
        const chatMessages: ChatMessage[] = messages as ChatMessage[]
        const result = await runChatSync({
          messages: chatMessages,
          contextDocId: context_doc_id,
          notebookId: notebook_id,
          since,
          until,
          topK: top_k,
          minScore: min_score,
          temperature,
          maxTokens: max_tokens,
        })
        return {
          content: [toText({
            answer: result.answer,
            citations: result.citations.map((c) => ({
              block_id: c.block_id,
              doc_id: c.doc_id,
              doc_title: c.doc_title,
              snippet: c.snippet,
              score: c.score,
            })),
            retrieval: result.retrieval,
            tool_trace: result.toolTrace,
          })],
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const notConfigured = msg.startsWith('[未配置]')
        return toolError(notConfigured ? 'not_configured' : 'llm_error', msg, notConfigured ? { fix_hint: NOT_CONFIGURED_HINT } : undefined)
      }
    },
  )

  server.registerTool(
    'notefast_autolink_suggestions',
    {
      description: 'AutoLink Inbox 视图：默认 review_status=unreviewed，含 AI 已应用 + AI 仅建议两类。',
      inputSchema: {
        doc_id: z.string().optional().describe('限定文档 ID（不传则全局）'),
        status: z.enum(['unreviewed', 'accepted', 'dismissed', 'all']).optional().default('unreviewed'),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
    },
    async ({ doc_id, status, limit }) => {
      const reviewStatus = status === 'all' ? undefined : (status as 'unreviewed' | 'accepted' | 'dismissed')
      const list = listSuggestions({
        docId: doc_id,
        reviewStatus,
        limit,
        actionStatus: ['suggested', 'applied', 'reverted'],
      })
      const db = getDb()
      const items = list.map((s) => {
        const wire = toWire(s)
        const src = db
          .query(
            `SELECT b.content, b.root_id, (SELECT content FROM blocks WHERE id = b.root_id) as doc_title
             FROM blocks b WHERE b.id = ?`,
          )
          .get(s.sourceBlockId) as { content: string; root_id: string; doc_title: string } | undefined
        return {
          ...wire,
          source_content: src?.content?.slice(0, 200) ?? '',
          source_doc_id: src?.root_id ?? null,
          source_doc_title: src?.doc_title ?? '',
        }
      })
      return { content: [toText({ status: status ?? 'unreviewed', count: items.length, items })] }
    },
  )

  server.registerTool(
    'notefast_autolink_apply',
    {
      description: '接受一条 AutoLink 建议，事务化写入 block_refs（ref_type=ai_suggested）；幂等。',
      inputSchema: {
        suggestion_id: z.string().describe('建议 ID'),
        candidate_index: z.number().int().min(0).max(4).optional().default(0),
      },
    },
    async ({ suggestion_id, candidate_index }) => {
      const result = applySuggestion(suggestion_id, candidate_index, 'ai_suggested')
      if (!result.applied && result.reason === 'not_found') {
        return toolError('not_found', `建议 ${suggestion_id} 不存在`, { suggestion_id })
      }
      return {
        content: [toText({
          applied: result.applied,
          ref_id: result.refId,
          target_id: result.targetBlockId,
          reason: result.reason,
        })],
      }
    },
  )

  server.registerTool(
    'notefast_autolink_dismiss',
    {
      description: '用户忽略一条 AutoLink 建议（review_status=dismissed，记录保留）',
      inputSchema: {
        suggestion_id: z.string().describe('建议 ID'),
      },
    },
    async ({ suggestion_id }) => {
      const result = dismissSuggestion(suggestion_id)
      if (!result.dismissed && result.reason === 'not_found') {
        return toolError('not_found', `建议 ${suggestion_id} 不存在`, { suggestion_id })
      }
      return { content: [toText({ dismissed: result.dismissed, reason: result.reason })] }
    },
  )

  server.registerTool(
    'notefast_autolink_revert',
    {
      description: '精确撤销一条已应用的 AutoLink 建议（按 created_ref_id 删除，可再次接受）',
      inputSchema: {
        suggestion_id: z.string().describe('建议 ID'),
      },
    },
    async ({ suggestion_id }) => {
      const result = revertSuggestion(suggestion_id)
      if (!result.reverted && result.reason === 'not_found') {
        return toolError('not_found', `建议 ${suggestion_id} 不存在`, { suggestion_id })
      }
      return { content: [toText({ reverted: result.reverted, reason: result.reason })] }
    },
  )

  server.registerTool(
    'notefast_autolink_run',
    {
      description: '对单个 block 立即触发 AutoLink 分析（AI 抽取实体 + 命中候选）',
      inputSchema: {
        block_id: z.string().describe('Block ID'),
      },
    },
    async ({ block_id }) => {
      if (!hasRuntime() || !getRuntime().hasChat()) {
        return toolError('not_configured', 'Chat 模型未配置', { fix_hint: NOT_CONFIGURED_HINT })
      }
      const db = getDb()
      const row = db.query('SELECT id, content, notebook_id FROM blocks WHERE id = ?').get(block_id) as
        | { id: string; content: string; notebook_id: string }
        | undefined
      if (!row) {
        return toolError('not_found', `Block ${block_id} 不存在`, { block_id })
      }
      const cfg = getRuntime().autoLinkConfig()
      const r = await analyzeBlock({
        blockId: row.id,
        content: row.content || '',
        notebookId: row.notebook_id,
        notebookScope: cfg.notebookScope,
        maxPerBlock: cfg.maxPerBlock,
      })
      return {
        content: [toText({
          analyzed: r.analyzed,
          suggestions_added: r.suggestionsAdded,
          applied: r.applied,
          errors: r.errors,
        })],
      }
    },
  )

  // ───────────────────── notefast_get_config ─────────────────────
  server.tool(
    'notefast_get_config',
    '获取服务端当前 AI / 鉴权配置概况（脱敏）。包含 chat、embedding、reranker 的模型名和 provider 标签，以及是否启用读写分离 token、密码鉴权等。不包含 API Key。',
    {},
    async () => {
      const s = getRuntime().status()
      const cfg = s.config
      const mode = {
        passwordRequired: (process.env.AUTH_PASSWORD || '').trim().length > 0,
        readToken: (process.env.READ_TOKEN || '').trim().length > 0,
        writeToken: (process.env.WRITE_TOKEN || '').trim().length > 0,
        apiToken: (process.env.API_TOKEN || '').trim().length > 0,
      }
      return {
        content: [toText({
          enabled: s.enabled,
          chat: cfg.chat ? { model: cfg.chat.chatModel, label: cfg.chat.label, baseUrl: cfg.chat.baseUrl } : null,
          embedding: cfg.embedding ? { model: cfg.embedding.embeddingModel, label: cfg.embedding.label, baseUrl: cfg.embedding.baseUrl } : null,
          reranker: cfg.reranker?.enabled ? { model: cfg.reranker.model, baseUrl: cfg.reranker.baseUrl } : null,
          autoIndex: cfg.autoIndex,
          auth: mode,
        })],
      }
    },
  )

  // ───────────────────── Resources ─────────────────────
  server.registerResource(
    'notefast_docs_index',
    'notefast://docs',
    { title: '全部文档', description: '知识库中所有文档的索引列表' },
    async () => {
      const rows = getDb().query("SELECT id, content FROM blocks WHERE type = 'document' ORDER BY updated_at DESC LIMIT 1000").all() as Array<{ id: string; content: string }>
      const lines = rows.map((r, i) => `${i + 1}. ${r.content || '(无标题)'}  (${r.id.slice(0, 8)})`).join('\n')
      return { contents: [{ text: (lines || '(暂无文档)').slice(0, 50_000), uri: 'notefast://docs' }] }
    },
  )

  // URI template 在 SDK TS 声明中不完全，用 any 桥接类型
  ;(server as any).registerResource(
    'notefast_doc',
    { uriTemplate: 'notefast://docs/{docId}' },
    { title: '单篇文档', description: '根据 docId 读取文档完整 Markdown 内容' },
    async (_uri: unknown, params: Record<string, string>) => {
      const docId = params?.docId
      if (!docId) return { contents: [{ text: '缺少 docId', uri: '' }] }
      const doc = getDb().query("SELECT * FROM blocks WHERE id = ? AND type = 'document'").get(docId) as BlockRow | undefined
      if (!doc) return { contents: [{ text: `文档 ${docId} 不存在`, uri: '' }] }
      const tree = buildBlockTree([doc, ...fetchDescendants(getDb(), docId)])
      const md = blocksToMarkdown(tree)
      return { contents: [{ text: md.slice(0, 50_000), uri: `notefast://docs/${docId}`, mimeType: 'text/markdown' }] }
    },
  )

  // ───────────────────── notefast_get_autolink_suggestion ─────────────────────
  server.tool(
    'notefast_get_autolink_suggestion',
    '查看一条 AutoLink 建议的完整详情（包含来源文本、候选链接、置信度等），之后可决定 apply 或 dismiss。',
    {
      suggestion_id: z.string().min(1).max(64).describe('suggestion ID'),
    },
    async ({ suggestion_id }) => {
      const db = getDb()
      const row = db.query('SELECT * FROM autolink_suggestions WHERE id = ?').get(suggestion_id) as unknown as {
        id: string
        source_block_id: string
        source_content: string
        source_doc_id: string | null
        source_doc_title: string
        anchor: string
        kind: string
        candidates: string // JSON
        action_status: string
        review_status: string
        confidence: number | null
        score_kind: string
        error: string | null
      } | undefined
      if (!row) return toolError('not_found', `建议 ${suggestion_id} 不存在`, { suggestion_id })
      let candidates: unknown[] = []
      try { candidates = JSON.parse(row.candidates) } catch { /* ignore */ }
      return {
        content: [toText({
          id: row.id,
          source_block_id: row.source_block_id,
          source_content: row.source_content.slice(0, 2_000),
          source_doc_title: row.source_doc_title,
          anchor: row.anchor,
          kind: row.kind,
          confidence: row.confidence,
          score_kind: row.score_kind,
          action_status: row.action_status,
          review_status: row.review_status,
          candidates: candidates.slice(0, 10),
          error: row.error,
        })],
      }
    },
  )
}

function fetchDescendants(database: ReturnType<typeof getDb>, rootId: string): BlockRow[] {
  const rows: BlockRow[] = []
  const stack = [rootId]

  while (stack.length > 0) {
    const currentId = stack.pop()!
    const children = database
      .query('SELECT * FROM blocks WHERE parent_id = ? ORDER BY sort ASC')
      .all(currentId) as BlockRow[]
    for (const child of children) {
      rows.push(child)
      stack.push(child.id)
    }
  }

  return rows
}

function limitTreeDepth(block: import('@notefast/core').Block, maxDepth: number): import('@notefast/core').Block {
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

function extractHeadings(rows: BlockRow[]): { id: string; content: string; level: number }[] {
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
