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
  findSuggestion,
  listSuggestionsForDoc,
  removeSuggestionById,
  toWire,
} from '../ai/autoLinkStore'
import {
  analyzeBlock,
  insertRef,
  listBlockIdsForDoc,
} from '../ai/autoLink'

function toText(data: unknown): { type: 'text'; text: string } {
  return { type: 'text' as const, text: JSON.stringify(data, null, 2) }
}

function validateNotebook(database: ReturnType<typeof getDb>, notebookId: string): { error: string } | null {
  const exists = database.query('SELECT id FROM notebooks WHERE id = ?').get(notebookId)
  if (!exists) {
    return { error: `笔记本 ${notebookId} 不存在` }
  }
  return null
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
        return { content: [toText({ error: `文档 ${doc_id} 不存在` })] }
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
        return { content: [toText({ error: `Block ${block_id} 不存在` })] }
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
          return { content: [toText({ error: `父块 ${parent_id} 不存在` })] }
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
        return { content: [toText({ error: `Block ${block_id} 不存在` })] }
      }

      db.query("UPDATE blocks SET content = ?, updated_at = datetime('now') WHERE id = ?").run(content, block_id)

      const row = db.query('SELECT * FROM blocks WHERE id = ?').get(block_id) as BlockRow
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

      db.query(
        `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
      ).run(docId, nid, docId, title, now, now)

      for (const inp of inputs) {
        const blockId = crypto.randomUUID()
        const parentId = inp.parent_id ?? docId

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
        return { content: [toText({ error: `文档 ${doc_id} 不存在` })] }
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
        return { content: [toText({ error: `文档 ${doc_id} 不存在` })] }
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
        return {
          content: [toText({
            error: 'AI 未配置',
            fix_hint: '请在 Web UI /settings 页面配置 Embedding 模型',
          })],
        }
      }
      try {
        const r = getRuntime()
        const vector = await r.embedQuery(query)
        if (!vector) {
          return { content: [toText({ error: 'embedding_failed', message: r.status().embedding.lastError })] }
        }
        const hits = semanticSearch(vector, limit ?? 10, notebook_id)
        return { content: [toText({ query, results: hits.length, hits })] }
      } catch (e) {
        return { content: [toText({ error: String(e), fix_hint: '请检查 /settings 中的 Provider 配置' })] }
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
        return {
          content: [toText({
            error: 'LLM 未配置',
            fix_hint: '请在 Web UI /settings 页面配置 Chat 模型',
          })],
        }
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
        return { content: [toText({ error: String(e) })] }
      }
    },
  )

  server.registerTool(
    'notefast_chat',
    {
      description:
        '与用户知识库对话：FTS5 + 语义检索 + 可选 reranker，再交给 LLM 生成带 [n] 引用的回答。返回完整 answer、citations 列表和 retrieval 统计。',
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
        top_k: z.number().int().min(1).max(20).optional().default(5).describe('返回引用数量'),
        temperature: z.number().min(0).max(2).optional().default(0.3),
        max_tokens: z.number().int().min(16).max(8000).optional().default(2000),
      },
    },
    async ({ messages, context_doc_id, top_k, temperature, max_tokens }) => {
      if (!hasRuntime() || !getRuntime().hasChat()) {
        return {
          content: [toText({
            error: 'AI chat 未配置',
            fix_hint: '请在 Web UI /settings 页面配置 Chat 模型',
          })],
        }
      }
      try {
        const chatMessages: ChatMessage[] = messages as ChatMessage[]
        const result = await runChatSync({
          messages: chatMessages,
          contextDocId: context_doc_id,
          topK: top_k,
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
          })],
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          content: [toText({
            error: msg.startsWith('[未配置]') ? 'not_configured' : 'llm_error',
            message: msg,
            fix_hint: msg.startsWith('[未配置]')
              ? '请在 Web UI /settings 页面配置 Chat 模型'
              : undefined,
          })],
        }
      }
    },
  )

  server.registerTool(
    'notefast_autolink_suggestions',
    {
      description: '列出某文档下的 AutoLink 待确认建议（用户接受 / 拒绝）',
      inputSchema: {
        doc_id: z.string().describe('文档 ID（block.tree 根 ID）'),
      },
    },
    async ({ doc_id }) => {
      const blockIds = listBlockIdsForDoc(doc_id)
      const list = listSuggestionsForDoc(doc_id, blockIds)
      return { content: [toText({ doc_id, count: list.length, suggestions: list.map(toWire) })] }
    },
  )

  server.registerTool(
    'notefast_autolink_apply',
    {
      description: '接受一条 AutoLink 建议，写入 block_refs（ref_type=ai_link）',
      inputSchema: {
        suggestion_id: z.string().describe('建议 ID'),
        candidate_index: z.number().int().min(0).max(4).optional().default(0),
      },
    },
    async ({ suggestion_id, candidate_index }) => {
      const s = findSuggestion(suggestion_id)
      if (!s) {
        return { content: [toText({ error: '建议不存在或已过期' })] }
      }
      const cand = s.candidates[candidate_index]
      if (!cand) {
        return { content: [toText({ error: '无效的 candidate_index' })] }
      }
      const ok = insertRef(s.sourceBlockId, cand.blockId, 'ai_link')
      removeSuggestionById(suggestion_id)
      return {
        content: [toText({
          applied: ok,
          source_id: s.sourceBlockId,
          target_id: cand.blockId,
          ref_type: 'ai_link',
        })],
      }
    },
  )

  server.registerTool(
    'notefast_autolink_dismiss',
    {
      description: '拒绝一条 AutoLink 建议，从内存中移除',
      inputSchema: {
        suggestion_id: z.string().describe('建议 ID'),
      },
    },
    async ({ suggestion_id }) => {
      const removed = removeSuggestionById(suggestion_id)
      return { content: [toText({ dismissed: removed })] }
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
        return { content: [toText({ error: 'not_configured', fix_hint: '请配置 Chat 模型' })] }
      }
      const db = getDb()
      const row = db.query('SELECT id, content, notebook_id FROM blocks WHERE id = ?').get(block_id) as
        | { id: string; content: string; notebook_id: string }
        | undefined
      if (!row) {
        return { content: [toText({ error: `Block ${block_id} 不存在` })] }
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
