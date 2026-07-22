/**
 * MCP 工具 —— 文档只读组
 *
 * notefast_search / get_doc / get_block / get_doc_tree / export_markdown /
 * get_backlinks，以及 2 个 resource（notefast://docs 索引与单篇文档）。
 */

import { z } from 'zod'
import {
  buildBlockTree,
  buildFtsQuery,
  blocksToMarkdown,
  highlightSnippet,
  rowToBlock,
  type BlockRow,
} from '@notefast/core'
import { getDb } from '../../db'
import { fetchDocBlocks, runFtsQuery } from '../../dbQueries'
import {
  isDocAiExcluded,
  loadAiExcludedDocIds,
} from '../../ai/aiExcludeQuery'
import {
  denyAiExcludedBlock,
  denyAiExcludedDoc,
  extractHeadings,
  limitTreeDepth,
  toText,
  toolError,
  type ToolContext,
} from './helpers'

export function registerDocReadTools(ctx: ToolContext): void {
  const { server, db, registerTool } = ctx

  registerTool(
    'notefast_search',
    {
      description: '全文搜索知识库，返回匹配的 block 列表',
      inputSchema: {
        query: z.string().min(1).max(1000).describe('搜索关键词'),
        notebook_id: z.string().optional().describe('限定笔记本 ID'),
        limit: z.number().int().min(1).max(100).optional().default(10).describe('最大返回数量'),
      },
    },
    async ({ query, notebook_id, limit }) => {
      const { query: ftsQuery } = buildFtsQuery(query, limit)

      // 多取 3 倍，过滤 ai_exclude 后截断
      const rows = runFtsQuery(db, {
        match: ftsQuery,
        notebookId: notebook_id,
        limit: limit as number,
        overfetch: 3,
      })
      const excluded = loadAiExcludedDocIds(rows.map((r) => r.root_id))
      const filtered = rows.filter((r) => !excluded.has(r.root_id)).slice(0, limit as number)

      return {
        content: [toText(filtered.map((r) => ({
          block_id: r.id,
          type: r.type,
          content: r.content,
          snippet: highlightSnippet(r.content, query),
          rank: r.rank,
        })))],
      }
    },
  )

  registerTool(
    'notefast_get_doc',
    {
      description: '获取文档完整内容（block 树）',
      inputSchema: {
        doc_id: z.string().describe('文档 ID'),
        depth: z.number().optional().default(5).describe('子块深度限制'),
      },
    },
    async ({ doc_id, depth }) => {
      const denied = denyAiExcludedDoc(doc_id)
      if (denied) return denied
      const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(doc_id, 'document') as BlockRow | undefined
      if (!docRow) {
        return toolError('not_found', `文档 ${doc_id} 不存在`, { doc_id })
      }

      const allRows = fetchDocBlocks(db, doc_id)
      const tree = buildBlockTree(allRows)

      return {
        content: [toText({
          doc: tree.length > 0 ? limitTreeDepth(tree[0], depth ?? 5) : null,
          block_count: allRows.length,
        })],
      }
    },
  )

  registerTool(
    'notefast_get_block',
    {
      description: '获取单个 block 及其上下文',
      inputSchema: {
        block_id: z.string().describe('Block ID'),
      },
    },
    async ({ block_id }) => {
      const denied = denyAiExcludedBlock(block_id)
      if (denied) return denied
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

  registerTool(
    'notefast_get_backlinks',
    {
      description: '获取反向链接（引用此 block 的 block 列表）',
      inputSchema: {
        block_id: z.string().describe('Block ID'),
      },
    },
    async ({ block_id }) => {
      const denied = denyAiExcludedBlock(block_id)
      if (denied) return denied
      // 目标 block 不存在时也要报 not_found，而不是返回空列表（调用方无法区分「没有反链」和「id 错了」）
      const target = db.query('SELECT id FROM blocks WHERE id = ?').get(block_id)
      if (!target) {
        return toolError('not_found', `Block ${block_id} 不存在`, { block_id })
      }
      const refs = db
        .query(
          `SELECT r.id, r.source_id, r.target_id, r.ref_type, r.created_at,
                  b.content as source_content, b.type as source_type, b.root_id as source_root_id
           FROM block_refs r
           JOIN blocks b ON b.id = r.source_id
           WHERE r.target_id = ?
           ORDER BY r.created_at DESC`,
        )
        .all(block_id) as Array<{
        id: number
        source_id: string
        target_id: string
        ref_type: string
        created_at: string
        source_content: string
        source_type: string
        source_root_id: string
      }>
      const excluded = loadAiExcludedDocIds(refs.map((r) => r.source_root_id))
      const visible = refs.filter((r) => !excluded.has(r.source_root_id))

      return {
        content: [toText({
          target_id: block_id,
          backlinks_count: visible.length,
          backlinks: visible.map((r) => ({
            source_id: r.source_id,
            source_content: r.source_content,
            source_type: r.source_type,
            ref_type: r.ref_type,
          })),
        })],
      }
    },
  )

  registerTool(
    'notefast_get_doc_tree',
    {
      description: '获取文档大纲（仅 heading 层级）',
      inputSchema: {
        doc_id: z.string().describe('文档 ID'),
      },
    },
    async ({ doc_id }) => {
      const denied = denyAiExcludedDoc(doc_id)
      if (denied) return denied
      const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(doc_id, 'document') as BlockRow | undefined
      if (!docRow) {
        return toolError('not_found', `文档 ${doc_id} 不存在`, { doc_id })
      }

      const headings = extractHeadings(fetchDocBlocks(db, doc_id))

      return {
        content: [toText({
          doc_id,
          doc_title: docRow.content,
          headings,
        })],
      }
    },
  )

  registerTool(
    'notefast_export_markdown',
    {
      description: '导出文档为 Markdown',
      inputSchema: {
        doc_id: z.string().describe('文档 ID'),
      },
    },
    async ({ doc_id }) => {
      const denied = denyAiExcludedDoc(doc_id)
      if (denied) return denied
      const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(doc_id, 'document') as BlockRow | undefined
      if (!docRow) {
        return toolError('not_found', `文档 ${doc_id} 不存在`, { doc_id })
      }

      const allRows = fetchDocBlocks(db, doc_id)
      const tree = buildBlockTree(allRows)
      const markdown = blocksToMarkdown(tree)

      return { content: [toText({ doc_id, markdown })] }
    },
  )

  // ───────────────────── Resources ─────────────────────
  server.registerResource(
    'notefast_docs_index',
    'notefast://docs',
    { title: '全部文档', description: '知识库中所有文档的索引列表（自动排除「对 AI 隐藏」的文档）' },
    async () => {
      const rows = getDb().query("SELECT id, content FROM blocks WHERE type = 'document' ORDER BY updated_at DESC LIMIT 1000").all() as Array<{ id: string; content: string }>
      const excluded = loadAiExcludedDocIds(rows.map((r) => r.id))
      const visible = rows.filter((r) => !excluded.has(r.id))
      const lines = visible.map((r, i) => `${i + 1}. ${r.content || '(无标题)'}  (${r.id.slice(0, 8)})`).join('\n')
      return { contents: [{ text: (lines || '(暂无文档)').slice(0, 50_000), uri: 'notefast://docs' }] }
    },
  )

  // URI template 在 SDK TS 声明中不完全，用 any 桥接类型
  ;(server as any).registerResource(
    'notefast_doc',
    { uriTemplate: 'notefast://docs/{docId}' },
    { title: '单篇文档', description: '根据 docId 读取文档完整 Markdown 内容（自动拒绝「对 AI 隐藏」的文档）' },
    async (_uri: unknown, params: Record<string, string>) => {
      const docId = params?.docId
      if (!docId) return { contents: [{ text: '缺少 docId', uri: '' }] }
      if (isDocAiExcluded(docId)) {
        return { contents: [{ text: `文档 ${docId} 已对 AI 隐藏，resource 不可访问`, uri: `notefast://docs/${docId}` }] }
      }
      const doc = getDb().query("SELECT * FROM blocks WHERE id = ? AND type = 'document'").get(docId) as BlockRow | undefined
      if (!doc) return { contents: [{ text: `文档 ${docId} 不存在`, uri: '' }] }
      const tree = buildBlockTree(fetchDocBlocks(getDb(), docId))
      const md = blocksToMarkdown(tree)
      return { contents: [{ text: md.slice(0, 50_000), uri: `notefast://docs/${docId}`, mimeType: 'text/markdown' }] }
    },
  )
}
