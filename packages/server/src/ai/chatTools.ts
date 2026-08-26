/**
 * Chat 工具层（定义 + 写工具执行）——从 ai/chat.ts 拆出。
 *
 * 定义：暴露给 LLM 的 tool schema（描述随 lang 本地化）；检索工具的执行
 * （executeToolCall）仍留在 chat.ts——它依赖 chat 的检索上下文。
 * 执行：executeWriteTool 由 agent loop / write-confirm 兼容端点共用，
 * 写库语义与 MCP/REST 写路径一致。
 */

import type { ToolDefinition } from '@notefast/core'
import { rowToBlock, blocksToMarkdown, buildBlockTree } from '@notefast/core'
import type { AiLang } from './locale'
import type { ToolResult } from './chat'
import { getRuntime, hasRuntime } from '../services/aiRuntime'
import { getDb } from '../db'
import { getBlockById, getBlocksByIds, getDocById, recordDocSnapshot, updateBlock, fetchDocBlocks } from '../store/blocks'
import { insertDocFromMarkdown, appendMarkdownToDoc, normalizeDocTags } from '../services/docImport'
import {
  createPinnedView,
  deletePinnedView,
  PinnedViewError,
  pinViewInputFromUnknown,
} from '../services/pinnedViews'
import { fireAfterCreate, fireAfterCreateMany, fireAfterUpdate, fireDocAfterCreate } from '../services/hooks'
import { scheduleSyncNow } from '../sync/protocolManager'
import { scheduleDocIndex } from './indexJobs'
import { emitAppEvent } from '../events'
import { loadAiExcludedDocIds } from './aiExcludeQuery'

/**
 * 暴露给 LLM 的工具定义。
 * 描述随 lang 本地化（英文助手让 LLM 用英文理解工具语义）。
 */
function getSearchToolDefinition(lang: AiLang): ToolDefinition {
  const en = lang === 'en'
  return {
    type: 'function',
    function: {
      name: 'notefast_search_more',
      description: en
        ? 'Re-search the knowledge base with different keywords, a narrower scope, or a time window. Call it when the initial results are insufficient, the user gets more specific, or a time dimension is needed (e.g. "what did I write last week").'
        : '用不同的关键词、缩小范围、加时间窗等条件重新检索知识库。当初始结果不够、用户问得更具体、或需要时间维度（"上次我写过什么"）时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: en ? 'New keywords; leave empty to use the last user message' : '新关键词；留空则用当前对话最后一条 user 消息' },
          notebook_id: { type: 'string', description: en ? 'Scope to a notebook (optional)' : '限定到某个 notebook（可选）' },
          since: { type: 'string', description: en ? 'ISO time string; only blocks with updated_at >= since' : 'ISO 时间字符串，只返回 blocks.updated_at >= since 的块' },
          until: { type: 'string', description: en ? 'ISO time string; only blocks with updated_at <= until' : 'ISO 时间字符串，只返回 blocks.updated_at <= until 的块' },
          limit: { type: 'number', description: en ? 'Number of citations to return (1-20)' : '返回的引用数量（1-20）', default: 5 },
          include_archived: { type: 'boolean', description: en ? 'Include archived documents (default false; set true only when the user explicitly wants old/historical content)' : '是否包含已归档文档（默认 false；仅当用户明确要找过时/历史内容时置 true）' },
        },
      },
    },
  }
}

/** 文档列表工具：让 LLM 能回答"有哪些笔记/收集箱里有什么/哪些长期没更新"类问题 */
function getListDocsToolDefinition(lang: AiLang): ToolDefinition {
  const en = lang === 'en'
  return {
    type: 'function',
    function: {
      name: 'notefast_list_docs',
      description: en
        ? 'List knowledge base documents (title/status/tags/updated time). Use for listing scenarios like "what notes do I have", "what is in the inbox", or "find documents not updated for a long time"; call notefast_read_doc for full text, or notefast_search_more for keyword snippets.'
        : '列出知识库文档（标题/状态/标签/更新时间）。用于"我有哪些笔记""收集箱里有什么""找长期未更新的文档"等列表性场景；需要全文时调用 notefast_read_doc，关键词片段再用 notefast_search_more。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['note', 'inbox', 'archived', 'all'], description: en ? 'note=notes (default, excludes inbox); to list the inbox you MUST pass "inbox" explicitly; archived=archive; all=everything' : 'note=正式笔记（默认，不含收集箱）；查收集箱必须显式传 inbox；archived=归档；all=全部' },
          stale_within: { type: 'string', enum: ['30d', '90d'], description: en ? 'Only documents not updated for longer than this' : '仅返回超过该时长未更新的文档（找过时内容用）' },
          updated_within: { type: 'string', enum: ['24h', '7d'], description: en ? 'Only recently updated documents' : '仅返回最近更新的文档' },
          limit: { type: 'number', description: en ? 'Number of results (1-50), default 20' : '返回数量（1-50），默认 20' },
        },
      },
    },
  }
}

/** 读全文工具：检索只给片段，需要完整文章时让 LLM 主动拉取整篇 Markdown */
function getReadDocToolDefinition(lang: AiLang): ToolDefinition {
  const en = lang === 'en'
  return {
    type: 'function',
    function: {
      name: 'notefast_read_doc',
      description: en
        ? 'Read the full content of a document (Markdown). Retrieval only returns block-level snippets — call this when the user needs the whole article, a full summary, or the snippets are insufficient. Get doc_id from the retrieval results or notefast_list_docs.'
        : '读取一篇文档的完整内容（Markdown）。检索结果只是 block 级片段，当需要完整文章、总结全文、或片段不足以回答时调用。doc_id 从检索结果或 notefast_list_docs 获取。',
      parameters: {
        type: 'object',
        properties: {
          doc_id: { type: 'string', description: en ? 'Target document ID' : '目标文档 ID' },
        },
        required: ['doc_id'],
      },
    },
  }
}

function getWriteToolDefinitions(lang: AiLang): ToolDefinition[] {
  const en = lang === 'en'
  return [
    {
      type: 'function',
      function: {
        name: 'notefast_create_note',
        description: en
          ? 'Create a new note in the knowledge base. The title must be concise (5-20 characters), the body in Markdown. Call when the user says "note this down", "save this", or "create a note". Do not add tags unless the user named them.'
          : '在知识库中创建一篇新笔记。标题必须简洁（5-20字），内容用 Markdown。当用户要求"记下来""保存这段""新建笔记"时调用。用户未指定标签时不要打标签。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: en ? 'Note title, 5-20 characters' : '笔记标题，5-20字' },
            markdown: { type: 'string', description: en ? 'Note body, Markdown. Display math: exclusive-line $$ or ```math. Inline: $...$. Do not write YAML tags just to label the note.' : '笔记正文，Markdown。块级公式用独占行 $$ 或 ```math，行内用 $...$。不要为了打标签而写 YAML frontmatter。' },
            status: { type: 'string', enum: ['note', 'inbox'], description: en ? 'note=notes, inbox=inbox; default note' : 'note=正式笔记，inbox=收集箱；默认 note' },
            tags: { type: 'array', items: { type: 'string' }, description: en ? 'Only if the user named tags; omit otherwise. Do not invent tags.' : '仅当用户明确指定标签时传入；未指定则省略，不要自行归纳' },
          },
          required: ['title', 'markdown'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'notefast_append_to_doc',
        description: en
          ? 'Append a section to the end of an existing document. Get doc_id from block.doc_id in the retrieval results. Call when the user says "add this to note XX" or "append to document XX".'
          : '向已有文档末尾追加一段内容。doc_id 从检索结果中的 block.doc_id 获取。当用户要求"加到那篇笔记里""补充到 XX 文档"时调用。',
        parameters: {
          type: 'object',
          properties: {
            doc_id: { type: 'string', description: en ? 'Target document ID (from retrieval results or the conversation)' : '目标文档 ID（从检索结果或之前的对话中获取）' },
            content: { type: 'string', description: en ? 'Content to append, Markdown format. Display math: exclusive-line $$ or ```math.' : '要追加的内容，Markdown 格式。块级公式用独占行 $$ 或 ```math。' },
            heading: { type: 'string', description: en ? 'Optional heading to insert before the content, e.g. "## Addendum"' : '追加内容前先插入的标题（可选），如"## 补充"' },
          },
          required: ['doc_id', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'notefast_update_block',
        description: en
          ? 'Update the content of an existing block. Get block_id from citation.block_id in the retrieval results. Call when the user says "change that part" or "rewrite it as XX". To edit several blocks, call this multiple times in one round.'
          : '更新已有 block 的内容。block_id 从检索结果的 citation.block_id 获取。当用户要求"修改那段""改成 XX"时调用。要改多处时，一轮里多次调用，不要改一处就停。',
        parameters: {
          type: 'object',
          properties: {
            block_id: { type: 'string', description: en ? 'Target block ID (from citation.block_id in the retrieval results)' : '目标 block ID（从检索结果的 citation.block_id 获取）' },
            content: { type: 'string', description: en ? 'New content, Markdown format' : '新内容，Markdown 格式' },
          },
          required: ['block_id', 'content'],
        },
      },
    },
  ]
}

function getPinnedViewToolDefinitions(lang: AiLang): ToolDefinition[] {
  const en = lang === 'en'
  return [
    {
      type: 'function',
      function: {
        name: 'notefast_list_pinned_views',
        description: en
          ? 'List sidebar pinned views (name + filter query). Call before creating a pin to avoid duplicates.'
          : '列出侧栏固定视图（名称 + 筛选 query）。新建固定视图前先看是否已有相同筛选。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'notefast_pin_view',
        description: en
          ? 'Pin a filter to the sidebar as a pinned view. Call when the user says "pin this filter" or "add a work-tag view". Do not invent filters the user did not mention.'
          : '把一组筛选固定到侧栏「固定视图」。用户说「固定这个筛选」「加一个 work 标签的视图」时调用。不要发明用户没提过的筛选。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: en ? 'Sidebar label, e.g. "Work" or "01-工作"' : '侧栏显示名，如「工作」或「01-工作」' },
            query: { type: 'string', description: en ? 'Raw filter string such as tags=work; wins over structured fields if set' : '筛选串，如 tags=work；与结构化字段二选一，query 优先' },
            tags: { type: 'array', items: { type: 'string' }, description: en ? 'Filter by these tags (compiled to tags=a,b)' : '按这些标签筛选（编译为 tags=a,b）' },
            tag_match: { type: 'string', enum: ['all', 'any'], description: en ? 'all=must have every tag (default); any=any of the tags' : '多标签：all=同时包含（默认），any=包含任一' },
            untagged: { type: 'boolean', description: en ? 'Only documents with no tags' : '仅未打标签的文档' },
            stale_within: { type: 'string', enum: ['30d', '90d'] },
            updated_within: { type: 'string', enum: ['24h', '7d', '30d'] },
            created_within: { type: 'string', enum: ['24h', '7d', '30d'] },
            ai_exclude: { type: 'boolean', description: en ? 'Only documents hidden from AI' : '仅对 AI 隐藏的文档' },
            status: { type: 'string', enum: ['inbox', 'archived', 'all'] },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'notefast_unpin_view',
        description: en
          ? 'Remove a pinned view. Get id from notefast_list_pinned_views.'
          : '取消固定视图。id 来自 notefast_list_pinned_views。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: en ? 'Pinned view ID' : '固定视图 ID' },
          },
          required: ['id'],
        },
      },
    },
  ]
}

export function getAllToolDefinitions(lang: AiLang): ToolDefinition[] {
  const en = lang === 'en'
  const tools: ToolDefinition[] = [
    getSearchToolDefinition(lang),
    getListDocsToolDefinition(lang),
    getReadDocToolDefinition(lang),
    ...getWriteToolDefinitions(lang),
    ...getPinnedViewToolDefinitions(lang),
  ]
  if (hasRuntime() && getRuntime().webSearchKey()) {
    tools.push({
      type: 'function',
      function: {
        name: 'notefast_web_search',
        description: en
          ? 'Search the internet for the latest information. Call when the user\'s question can\'t be answered from the knowledge base notes and needs external/current info. Results come from the web and are marked separately from note citations.'
          : '搜索互联网获取最新信息。当用户的问题在知识库笔记中找不到答案、需要外部最新资讯时调用。结果来自网络，与笔记引用分开标注。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: en ? 'Search keywords' : '搜索关键词' },
            count: { type: 'number', description: en ? 'Number of results (1-10), default 5' : '返回条数（1-10），默认 5' },
          },
          required: ['query'],
        },
      },
    })
  }
  return tools
}

/**
 * 写工具（改库）集合：agent loop 中直接执行（executeWriteTool），
 * 不再返回「写入提案」等用户确认——文档有 block_revisions / doc_snapshots 历史，
 * 写错可随时回退（POST /blocks/:id/revisions/:rev/restore），确认卡片流程已废弃。
 */
export const WRITE_TOOLS = new Set([
  'notefast_create_note',
  'notefast_append_to_doc',
  'notefast_update_block',
  'notefast_pin_view',
  'notefast_unpin_view',
])

/** 写工具上下文（agent loop 与 write-confirm 兼容端点共用） */
export interface WriteToolContext {
  notebookId?: string
}

/**
 * 执行写工具（create_note / append_to_doc / update_block）。
 * 由 chat agent loop 直接调用（写操作不再需要用户确认，文档历史可回退）；
 * REST /ai/chat/write-confirm 端点保留兼容（外部客户端），同样走这里。
 * 写库统一走这里，保证与既有 MCP/REST 写路径行为一致。
 */
export async function executeWriteTool(name: string, args: Record<string, unknown>, ctx: WriteToolContext): Promise<ToolResult> {
  if (name === 'notefast_create_note') {
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    const markdown = typeof args.markdown === 'string' ? args.markdown : ''
    if (!title || !markdown) {
      return { content: JSON.stringify({ error: 'title 和 markdown 不能为空' }), resultCount: 0 }
    }
    const status = args.status === 'inbox' ? 'inbox' : 'note'
    const rawTags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === 'string') : []
    const db = getDb()
    const notebookId = ctx.notebookId || guessNotebookId(db)
    try {
      const result = insertDocFromMarkdown(db, {
        notebookId,
        title,
        markdown,
        status,
        tags: rawTags.length ? normalizeDocTags(rawTags) : undefined,
        applyFrontmatterTags: false,
      })
      // 与 MCP notefast_create_doc 对齐：索引作业 + afterCreate hooks（doc 先、子块批量），
      // 否则聊天创建的笔记跳过自动索引与 doc 变更广播
      const docRow = getBlockById(db, result.docId)!
      const indexJob = scheduleDocIndex(result.docId, result.blockIds)
      fireAfterCreate(rowToBlock(docRow))
      scheduleSyncNow()
      fireDocAfterCreate({
        doc: rowToBlock(docRow),
        meta: { status, source: 'ai' },
      })
      emitAppEvent({
        source: 'mcp',
        actor: 'ai-agent',
        action: 'doc.created_by_agent',
        target: { type: 'doc', id: result.docId },
        outcome: 'success',
        fields: { title, status, block_count: result.parsedCount + 1 },
      })
      if (result.blockIds.length > 0) {
        const childRows = getBlocksByIds(db, result.blockIds)
        fireAfterCreateMany(childRows.map(rowToBlock))
      }
      return {
        content: JSON.stringify({
          success: true,
          doc_id: result.docId,
          title,
          block_count: result.parsedCount + 1,
          status,
          ...(indexJob ? { index_job: indexJob } : {}),
        }),
        resultCount: 1,
      }
    } catch (e) {
      return {
        content: JSON.stringify({ error: `创建笔记失败: ${e instanceof Error ? e.message : e}` }),
        resultCount: 0,
      }
    }
  }

  if (name === 'notefast_append_to_doc') {
    const docId = typeof args.doc_id === 'string' ? args.doc_id.trim() : ''
    const content = typeof args.content === 'string' ? args.content : ''
    if (!docId || !content) {
      return { content: JSON.stringify({ error: 'doc_id 和 content 不能为空' }), resultCount: 0 }
    }
    const db = getDb()
    const doc = getDocById(db, docId)
    if (!doc) {
      return { content: JSON.stringify({ error: `文档 ${docId} 不存在` }), resultCount: 0 }
    }
    const excluded = loadAiExcludedDocIds([docId])
    if (excluded.has(docId)) {
      return { content: JSON.stringify({ error: `文档 ${docId} 已对 AI 隐藏` }), resultCount: 0 }
    }

    const heading = typeof args.heading === 'string' && args.heading.trim()
    const fullContent = heading ? `${heading}\n\n${content}` : content

    // 追加前先记「保存前快照」（actor='ai'），与 PUT /docs/:id/markdown 的整篇快照语义一致：
    // 历史面板据此显示「AI 写入」，且可回退到追加前的状态。
    // 快照与追加分两个事务：快照先行，追加失败至多多一条旧快照，无副作用。
    const oldMarkdown = blocksToMarkdown(buildBlockTree(fetchDocBlocks(db, docId)))
    recordDocSnapshot(db, docId, oldMarkdown, 'ai')

    // 追加内容与编辑保存同语义：解析为结构化 block 树入库，
    // 否则整段 Markdown 原文会成为单个 paragraph，预览把 ```、表格等按纯文本渲染
    const { blockIds, parsedCount } = appendMarkdownToDoc(db, {
      docId,
      notebookId: doc.notebook_id,
      markdown: fullContent,
    })
    if (parsedCount === 0) {
      return { content: JSON.stringify({ error: '内容无法解析为有效 block' }), resultCount: 0 }
    }

    // 与 PUT /docs/:id/markdown 一致的副作用：索引作业 + afterCreate hooks + 更新文档
    const indexJob = scheduleDocIndex(docId, blockIds)
    if (blockIds.length > 0) {
      const newRows = getBlocksByIds(db, blockIds)
      fireAfterCreateMany(newRows.map(rowToBlock))
    }
    const updatedDocRow = getBlockById(db, docId)!
    fireAfterUpdate(rowToBlock(updatedDocRow))
    scheduleSyncNow()
    emitAppEvent({
      source: 'mcp',
      actor: 'ai-agent',
      action: 'doc.appended_by_agent',
      target: { type: 'doc', id: docId },
      outcome: 'success',
      fields: { block_count: parsedCount },
    })

    return {
      content: JSON.stringify({
        success: true,
        block_ids: blockIds,
        block_count: parsedCount,
        doc_id: docId,
        ...(indexJob ? { index_job: indexJob } : {}),
        message: `已将 ${parsedCount} 个 block 追加到文档 ${docId}`,
      }),
      resultCount: 1,
    }
  }

  if (name === 'notefast_update_block') {
    const blockId = typeof args.block_id === 'string' ? args.block_id.trim() : ''
    const newContent = typeof args.content === 'string' ? args.content : ''
    if (!blockId || !newContent) {
      return { content: JSON.stringify({ error: 'block_id 和 content 不能为空' }), resultCount: 0 }
    }
    const db = getDb()
    const row = getBlockById(db, blockId)
    if (!row) {
      return { content: JSON.stringify({ error: `Block ${blockId} 不存在` }), resultCount: 0 }
    }
    const excluded = loadAiExcludedDocIds([row.root_id])
    if (excluded.has(row.root_id)) {
      return { content: JSON.stringify({ error: `Block ${blockId} 所属文档已对 AI 隐藏` }), resultCount: 0 }
    }
    // actor='ai'：block revision 历史面板（actorLabel）据此显示「AI 写入」
    updateBlock(db, blockId, { content: newContent, actor: 'ai' })
    scheduleSyncNow()
    emitAppEvent({
      source: 'mcp',
      actor: 'ai-agent',
      action: 'block.updated_by_agent',
      target: { type: 'block', id: blockId },
      outcome: 'success',
      fields: { doc_id: row.root_id },
    })
    return {
      content: JSON.stringify({
        success: true,
        block_id: blockId,
        message: `已更新 block ${blockId.slice(0, 8)}`,
      }),
      resultCount: 1,
    }
  }

  if (name === 'notefast_pin_view') {
    try {
      const { view, created } = createPinnedView(pinViewInputFromUnknown(args))
      return {
        content: JSON.stringify({ success: true, ...view, created }),
        resultCount: 1,
      }
    } catch (e) {
      const msg = e instanceof PinnedViewError ? e.message : (e instanceof Error ? e.message : String(e))
      return { content: JSON.stringify({ error: msg }), resultCount: 0 }
    }
  }

  if (name === 'notefast_unpin_view') {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (!id) {
      return { content: JSON.stringify({ error: 'id 不能为空' }), resultCount: 0 }
    }
    const ok = deletePinnedView(id)
    if (!ok) {
      return { content: JSON.stringify({ error: `固定视图 ${id} 不存在` }), resultCount: 0 }
    }
    return { content: JSON.stringify({ success: true, deleted: true, id }), resultCount: 1 }
  }

  return { content: JSON.stringify({ error: `未知写工具 ${name}` }), resultCount: 0 }
}

function guessNotebookId(db: ReturnType<typeof getDb>): string {
  const row = db.query("SELECT id FROM notebooks ORDER BY created_at ASC LIMIT 1").get() as
    | { id: string } | undefined
  return row?.id ?? 'default'
}

