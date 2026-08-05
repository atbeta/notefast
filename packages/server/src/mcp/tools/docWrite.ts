/**
 * MCP 工具 —— 文档写入与列表组
 *
 * notefast_create_block / update_block / create_doc /
 * stage_markdown / create_doc_from_file /
 * list_docs / list_tags / set_doc_tags。
 */

import { z } from 'zod'
import {
  getTagProvider,
  parseDocStatusFilter,
  parseTagMatchMode,
  parseTagsQueryParam,
  readDocStatus,
  readTags,
  rowToBlock,
} from '@notefast/core'
import { insertDocFromMarkdown } from '../../services/docImport'
import {
  createDocFromMarkdownFile,
  DocFileImportError,
} from '../../services/docFileImport'
import {
  MAX_STAGE_CHUNK_BYTES,
  StageError,
  stageMarkdownChunk,
} from '../../services/markdownStage'
import {
  fetchDeletedSubtreeIds,
  getBlockAnchor,
  getBlockById,
  getBlocksByIds,
  getDeletedBlockById,
  getDocById,
  insertBlock,
  listDocRows,
  listRecentlyDeletedBlocks,
  nowTimestamp,
  restoreBlocks,
  updateBlock,
} from '../../store/blocks'
import { fireAfterCreate, fireAfterCreateMany, fireAfterUpdate } from '../../services/hooks'
import { scheduleDocIndex } from '../../ai/indexJobs'
import { scheduleSyncNow } from '../../sync/protocolManager'
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
        const parent = getBlockAnchor(db, parent_id)
        if (!parent) {
          return toolError('not_found', `父块 ${parent_id} 不存在`, { parent_id })
        }
        rootId = parent.root_id
        level = parent.level + 1
      } else {
        rootId = id
      }

      insertBlock(db, {
        id,
        notebook_id: nid,
        parent_id: parent_id || null,
        root_id: rootId,
        type,
        content,
        sort: 0,
        level,
        now: nowTimestamp(),
      })

      const row = getBlockById(db, id)!
      fireAfterCreate(rowToBlock(row))
      scheduleSyncNow()
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
      const existing = getBlockById(db, block_id)
      if (!existing) {
        return toolError('not_found', `Block ${block_id} 不存在`, { block_id })
      }

      // actor='mcp'：block revision 历史面板（actorLabel）据此显示「MCP 写入」
      updateBlock(db, block_id, { content, actor: 'mcp' })

      const row = getBlockById(db, block_id)!
      fireAfterUpdate(rowToBlock(row))
      scheduleSyncNow()
      return { content: [toText({ block: rowToBlock(row) })] }
    },
  )

  registerTool(
    'notefast_create_doc',
    {
      description:
        '从短 Markdown 字符串创建文档（适合几段以内）。长文/本地文件请用 notefast_stage_markdown + notefast_create_doc_from_file，避免正文经模型转写导致换行丢失。',
      inputSchema: {
        notebook_id: z.string().optional().describe('笔记本 ID，默认使用默认笔记本'),
        title: z.string().describe('文档标题'),
        markdown: z.string().describe('Markdown 内容（短文）'),
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
      const docRow = getBlockById(db, docId)!
      const indexJob = scheduleDocIndex(docId, blockIds)
      fireAfterCreate(rowToBlock(docRow))
      fireAfterCreateMany(getBlocksByIds(db, blockIds).map(rowToBlock))
      scheduleSyncNow()

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
    'notefast_stage_markdown',
    {
      description:
        '分块上传 Markdown 正文到服务端暂存（大文件建档用）。返回 upload_id；继续追加时传入同一 upload_id。单次 chunk 建议 ≤64KiB。完成后调用 notefast_create_doc_from_file(upload_id=...)。',
      inputSchema: {
        chunk: z.string().min(1).describe('本段 Markdown 原文（勿改写换行）'),
        upload_id: z.string().optional().describe('续传时传入；首块省略由服务端生成'),
      },
    },
    async ({ chunk, upload_id }) => {
      try {
        const r = stageMarkdownChunk(chunk, upload_id)
        return {
          content: [toText({
            upload_id: r.upload_id,
            size: r.size,
            max_chunk_bytes: MAX_STAGE_CHUNK_BYTES,
            next: '继续 stage 或调用 notefast_create_doc_from_file',
          })],
        }
      } catch (e) {
        if (e instanceof StageError) {
          return toolError(e.code, e.message)
        }
        throw e
      }
    },
  )

  registerTool(
    'notefast_create_doc_from_file',
    {
      description:
        '从文件正文创建文档：传 content（小文件一次上传）或 upload_id（先 stage_markdown 分块）。服务端按 Markdown 解析为多 block；会规范化换行并尽量修复字面量 \\n 损坏。长文请走 upload_id，勿用 create_doc。',
      inputSchema: {
        notebook_id: z.string().optional().describe('笔记本 ID，默认使用默认笔记本'),
        content: z.string().optional().describe('完整 Markdown 文件正文；与 upload_id 二选一'),
        upload_id: z.string().optional().describe('notefast_stage_markdown 返回的 id；与 content 二选一'),
        filename: z.string().optional().describe('原文件名（用于推断标题，如 notes/foo.md）'),
        title: z.string().optional().describe('文档标题；缺省用 filename 或首个 H1'),
        status: z.enum(['note', 'inbox']).optional().describe('inbox=收集箱；缺省 note'),
        tags: z.array(z.string().min(1).max(64)).max(64).optional().describe('初始标签'),
      },
    },
    async ({ notebook_id, content, upload_id, filename, title, status, tags }) => {
      const nid = notebook_id || notebookId
      const nbErr = validateNotebook(db, nid)
      if (nbErr) return nbErr

      try {
        const result = createDocFromMarkdownFile(db, {
          notebookId: nid,
          content,
          uploadId: upload_id,
          filename,
          title,
          status,
          tags,
        })

        const docRow = getBlockById(db, result.docId)!
        const indexJob = scheduleDocIndex(result.docId, result.blockIds)
        fireAfterCreate(rowToBlock(docRow))
        fireAfterCreateMany(getBlocksByIds(db, result.blockIds).map(rowToBlock))
        scheduleSyncNow()
        const missing = findMissingAssets(extractAssetRefs(result.markdown))

        return {
          content: [toText({
            doc_id: result.docId,
            title: result.title,
            block_count: result.parsedCount + 1,
            ...(indexJob ? { index_job: indexJob } : {}),
            ...(missing.length > 0 ? { missing_assets: missing } : {}),
          })],
        }
      } catch (e) {
        if (e instanceof DocFileImportError) {
          return toolError(e.code, e.message)
        }
        throw e
      }
    },
  )

  registerTool(
    'notefast_list_docs',
    {
      description: '列出文档列表（默认排除「对 AI 隐藏」、收集箱与归档；status=inbox/archived 可列对应集合）',
      inputSchema: {
        notebook_id: z.string().optional().describe('笔记本 ID，默认使用默认笔记本'),
        tags: z.string().optional().describe('逗号分隔 tags；默认同时包含全部（AND），tag_match=any 时为包含任一'),
        tag_match: z.enum(['all', 'any']).optional().describe('多 tag 匹配：all=同时包含（默认），any=包含任一'),
        untagged: z.boolean().optional().describe('仅未打标文档'),
        updated_within: z.enum(['24h', '7d']).optional().describe('仅最近更新的文档'),
        status: z.enum(['note', 'inbox', 'archived', 'all']).optional().describe('note=正式笔记（默认）；inbox=收集箱；archived=归档；all=全部'),
      },
    },
    async ({ notebook_id, tags, tag_match, untagged, updated_within, status }) => {
      const nid = notebook_id || notebookId

      const rows = listDocRows(db, { notebookId: nid })

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
      const rows = listDocRows(db, { notebookId: notebook_id ? nid : undefined })
      const counts = new Map<string, number>()
      for (const r of rows) {
        if (isDocRowAiExcluded(r)) continue
        if (readDocStatus(r) !== 'note') continue
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
      const docRow = getDocById(db, doc_id)
      if (!docRow) {
        return toolError('not_found', `文档 ${doc_id} 不存在`, { doc_id })
      }
      const provider = getTagProvider()
      const updated = provider.setDocTags(docRow, tags)
      updateBlock(db, doc_id, { tags: updated.tags })
      scheduleSyncNow()
      const finalTags = provider.getDocTags(updated)
      return {
        content: [toText({ doc_id, tags: finalTags })],
      }
    },
  )

  registerTool(
    'notefast_restore_block',
    {
      description: '恢复已软删除的 block 及其子树',
      inputSchema: {
        block_id: z.string().describe('要恢复的 block ID（is_deleted=1 的行）'),
      },
    },
    async ({ block_id }) => {
      const existing = getDeletedBlockById(db, block_id)
      if (!existing) {
        return toolError('not_found', `未找到可恢复的已删除 block ${block_id}`, { block_id })
      }

      const allIds = [block_id, ...fetchDeletedSubtreeIds(db, block_id)]
      restoreBlocks(db, allIds)
      scheduleSyncNow()

      return { content: [toText({ restored: true, block_id, count: allIds.length })] }
    },
  )

  registerTool(
    'notefast_list_deleted',
    {
      description: '列出最近软删除的 blocks',
      inputSchema: {
        within: z.enum(['7d', '30d']).optional().describe('时间窗口，默认 30d'),
      },
    },
    async ({ within }) => {
      const days = within === '7d' ? 7 : 30
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

      const rows = listRecentlyDeletedBlocks(db, cutoff)

      return {
        content: [toText({
          deleted_count: rows.length,
          within: `${days}d`,
          blocks: rows.map((r) => ({
            id: r.id,
            type: r.type,
            content: r.content,
            notebook_id: r.notebook_id,
            root_id: r.root_id,
            deleted_at: r.updated_at,
          })),
        })],
      }
    },
  )
}
