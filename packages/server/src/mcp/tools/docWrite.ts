/**
 * MCP 工具 —— 文档写入与列表组
 *
 * notefast_create_block / update_block / create_doc / list_docs /
 * list_tags / set_doc_tags。
 */

import { z } from 'zod'
import {
  getTagProvider,
  isDocInbox,
  parseDocStatusFilter,
  parseTagMatchMode,
  parseTagsQueryParam,
  readDocStatus,
  readTags,
  rowToBlock,
  type BlockRow,
} from '@notefast/core'
import { insertDocFromMarkdown } from '../../services/docImport'
import { fireAfterCreate, fireAfterCreateMany, fireAfterUpdate } from '../../services/hooks'
import { scheduleDocIndex } from '../../ai/indexJobs'
import { extractAssetRefs, findMissingAssets } from '../../assets/store'
import { isDocRowAiExcluded } from '../../ai/aiExcludeQuery'
import {
  denyAiExcludedBlock,
  denyAiExcludedDoc,
  filterDocRowsForMcp,
  toText,
  toolError,
  validateNotebook,
  type ToolContext,
} from './helpers'

export function registerDocWriteTools(ctx: ToolContext): void {
  const { db, notebookId, registerTool } = ctx

  registerTool(
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
      if (nbErr) return nbErr

      // 父块属于 ai_exclude 文档时拒绝创建子块
      if (parent_id) {
        const denied = denyAiExcludedBlock(parent_id)
        if (denied) return denied
      }

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

  registerTool(
    'notefast_update_block',
    {
      description: '更新 block 内容',
      inputSchema: {
        block_id: z.string().describe('Block ID'),
        content: z.string().max(500_000).describe('新内容（Markdown 格式）'),
      },
    },
    async ({ block_id, content }) => {
      const denied = denyAiExcludedBlock(block_id)
      if (denied) return denied
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

  registerTool(
    'notefast_create_doc',
    {
      description: '从 Markdown 创建文档（可指定 status=inbox 创建到收集箱）',
      inputSchema: {
        notebook_id: z.string().optional().describe('笔记本 ID，默认使用默认笔记本'),
        title: z.string().describe('文档标题'),
        markdown: z.string().describe('Markdown 内容'),
        status: z.enum(['note', 'inbox']).optional().describe('inbox=收集箱；缺省 note'),
      },
    },
    async ({ notebook_id, title, markdown, status }) => {
      const nid = notebook_id || notebookId
      const nbErr = validateNotebook(db, nid)
      if (nbErr) return nbErr

      const { docId, blockIds, parsedCount } = insertDocFromMarkdown(db, {
        notebookId: nid,
        title,
        markdown,
        status,
      })

      // Hook 触发（fire-and-forget）：先 doc，再批量子块；索引进度走 scheduleDocIndex
      const docRow = db.query('SELECT * FROM blocks WHERE id = ?').get(docId) as BlockRow
      const indexJob = scheduleDocIndex(docId, blockIds)
      fireAfterCreate(rowToBlock(docRow))
      if (blockIds.length > 0) {
        const placeholders = blockIds.map(() => '?').join(',')
        const childRows = db
          .query(`SELECT * FROM blocks WHERE id IN (${placeholders})`)
          .all(...blockIds) as BlockRow[]
        fireAfterCreateMany(childRows.map(rowToBlock))
      }

      return {
        content: [toText({
          doc_id: docId,
          title,
          block_count: parsedCount + 1,
          ...(indexJob ? { index_job: indexJob } : {}),
          // asset 引用对账：悬空引用告警（不阻断创建）
          ...(() => {
            const missing = findMissingAssets(extractAssetRefs(markdown))
            return missing.length > 0 ? { missing_assets: missing } : {}
          })(),
        })],
      }
    },
  )

  registerTool(
    'notefast_list_docs',
    {
      description: '列出文档列表（默认排除「对 AI 隐藏」与收集箱；status=inbox 可列收集箱）',
      inputSchema: {
        notebook_id: z.string().optional().describe('笔记本 ID，默认使用默认笔记本'),
        tags: z.string().optional().describe('逗号分隔 tags；默认同时包含全部（AND），tag_match=any 时为包含任一'),
        tag_match: z.enum(['all', 'any']).optional().describe('多 tag 匹配：all=同时包含（默认），any=包含任一'),
        untagged: z.boolean().optional().describe('仅未打标文档'),
        updated_within: z.enum(['24h', '7d']).optional().describe('仅最近更新的文档'),
        status: z.enum(['note', 'inbox', 'all']).optional().describe('note=正式笔记（默认）；inbox=收集箱；all=全部'),
      },
    },
    async ({ notebook_id, tags, tag_match, untagged, updated_within, status }) => {
      const nid = notebook_id || notebookId

      const rows = db
        .query('SELECT * FROM blocks WHERE type = ? AND notebook_id = ? ORDER BY updated_at DESC')
        .all('document', nid) as BlockRow[]

      const filtered = filterDocRowsForMcp(rows, {
        tags: parseTagsQueryParam(tags),
        tagMatch: parseTagMatchMode(tag_match),
        untagged: untagged === true,
        updatedWithin: updated_within ?? null,
        status: parseDocStatusFilter(status),
      })

      return {
        content: [toText({
          notebook_id: nid,
          doc_count: filtered.length,
          docs: filtered.map((r) => ({
            id: r.id,
            title: r.content,
            created_at: r.created_at,
            updated_at: r.updated_at,
            tags: readTags(r),
            status: readDocStatus(r),
          })),
        })],
      }
    },
  )

  registerTool(
    'notefast_list_tags',
    {
      description: '列出知识库中使用过的标签及文档计数',
      inputSchema: {
        notebook_id: z.string().optional().describe('限定笔记本 ID'),
      },
    },
    async ({ notebook_id }) => {
      const nid = notebook_id || notebookId
      let rows: BlockRow[]
      if (notebook_id) {
        rows = db
          .query("SELECT * FROM blocks WHERE type = 'document' AND notebook_id = ?")
          .all(nid) as BlockRow[]
      } else {
        rows = db.query("SELECT * FROM blocks WHERE type = 'document'").all() as BlockRow[]
      }
      const counts = new Map<string, number>()
      for (const r of rows) {
        if (isDocRowAiExcluded(r)) continue
        if (isDocInbox(r)) continue
        for (const t of readTags(r)) {
          counts.set(t, (counts.get(t) ?? 0) + 1)
        }
      }
      const tags = Array.from(counts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag))
      return {
        content: [toText({ provider: getTagProvider().name, tags })],
      }
    },
  )

  registerTool(
    'notefast_set_doc_tags',
    {
      description: '设置文档标签（全量替换）',
      inputSchema: {
        doc_id: z.string().describe('文档 ID'),
        tags: z.array(z.string()).describe('标签列表（全量替换）'),
      },
    },
    async ({ doc_id, tags }) => {
      const denied = denyAiExcludedDoc(doc_id)
      if (denied) return denied
      const docRow = db
        .query("SELECT * FROM blocks WHERE id = ? AND type = 'document'")
        .get(doc_id) as BlockRow | undefined
      if (!docRow) {
        return toolError('not_found', `文档 ${doc_id} 不存在`, { doc_id })
      }
      const provider = getTagProvider()
      const updated = provider.setDocTags(docRow, tags)
      db.query(
        "UPDATE blocks SET tags = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(updated.tags, doc_id)
      const finalTags = provider.getDocTags(updated)
      return {
        content: [toText({ doc_id, tags: finalTags })],
      }
    },
  )
}
