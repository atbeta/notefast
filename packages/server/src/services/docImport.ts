/**
 * Markdown → 文档 统一入库服务
 *
 * 由 POST /docs、POST /import/markdown、MCP notefast_create_doc 三处共用
 * （原先三份实现已分叉：事务有无、stripTitleHeading 有无、子块 sort 全 0 或递增）。
 * 统一语义：
 * - 单事务写入（doc 根 + 全部子块）
 * - stripTitleHeading：剥离与标题重复的首个 H1（其子块提升为文档直属）
 * - 子块 sort = 0 起递增的序号 i（保持 Markdown 原始顺序）
 * - 解析期临时 id → 真实 id 的父链映射：嵌套块（fenced code / 子列表等）的
 *   parent_id 不指向未入库的临时 UUID，immediate FK 下也成立
 *   （parseMarkdownToBlocks 前序遍历保证父先于子插入，mcp-server.test.ts
 *   的 FK 回归测试覆盖此语义）
 * - 子块 level 按父链深度计算（文档根 = 0，顶层子块 = 1，逐层 +1）
 */

import { parseMarkdownToBlocks, stripTitleHeading } from '@notefast/core'
import type { CreateBlockInput } from '@notefast/core'
import type { getDb } from '../db'
import { findDocIdBySource, getMaxChildSort, insertBlock, nowTimestamp } from '../store/blocks'

type Db = ReturnType<typeof getDb>

export { findDocIdBySource }

/** Markdown 解析不出任何 block 时抛出（调用方映射为 400） */
export class EmptyMarkdownError extends Error {}

export interface InsertDocFromMarkdownOptions {
  notebookId: string
  title: string
  markdown: string
  /** inbox=收集箱；缺省 note */
  status?: 'note' | 'inbox'
  /** true 时解析结果为空抛 EmptyMarkdownError（import 接口的 400 语义） */
  rejectEmpty?: boolean
  /** 初始标签（已 normalize） */
  tags?: string[]
  /** 指定文档根 id（导入自家导出档时复用 manifest 中的 docId，实现幂等还原） */
  docId?: string
  /**
   * 来源溯源（连接器架构预留）：外部系统推入的文档记录来源标识，
   * 存于文档根 properties.source；后续同步按 (provider, external_id)
   * 查找既有文档做更新而非重复新建（见 findDocIdBySource）。
   */
  source?: DocSourceRef
}

/** 外部来源标识（未来连接器：webhook / RSS / 剪藏插件等） */
export interface DocSourceRef {
  /** 来源提供方标识，如 'webhook' / 'rss' / 'chrome-clipper' */
  provider: string
  /** 来源系统内的唯一 ID（原文 URL、条目 ID 等） */
  external_id: string
  /** 最近一次同步时间（ISO） */
  synced_at?: string
}

/**
 * 按来源标识查找文档的实现在 store/blocks.ts（数据访问层），
 * 此处 re-export 保持 docImport 的对外面不变（来源溯源语义见上方注释）。
 */

export interface InsertDocFromMarkdownResult {
  docId: string
  /** 实际入库的子块 id（顺序 = 插入顺序） */
  blockIds: string[]
  /** 解析并剥离标题后入库的子块数量（= blockIds.length） */
  parsedCount: number
}

export function insertDocFromMarkdown(
  db: Db,
  opts: InsertDocFromMarkdownOptions,
): InsertDocFromMarkdownResult {
  const rawInputs = parseMarkdownToBlocks(opts.markdown, opts.notebookId)
  if (opts.rejectEmpty && rawInputs.length === 0) {
    throw new EmptyMarkdownError('无法解析 Markdown 内容')
  }
  // 剥离与标题重复的首个 H1（导出的 markdown 首行是 `# {标题}`，直接回解析会重复入库）
  const inputs = stripTitleHeading(rawInputs, opts.title)

  const docStatus = opts.status === 'inbox' ? 'inbox' : 'note'
  const docId = opts.docId ?? crypto.randomUUID()
  const now = nowTimestamp()

  let blockIds: string[] = []
  db.transaction(() => {
    // 安全网：PRAGMA 作用域限本事务，提交时检查 FK，避免 immediate 阶段炸开
    db.run('PRAGMA defer_foreign_keys = ON')

    const initialTags = opts.tags?.length ? JSON.stringify(opts.tags) : '[]'
    const docProperties = opts.source ? JSON.stringify({ source: opts.source }) : '{}'

    insertBlock(db, {
      id: docId,
      notebook_id: opts.notebookId,
      parent_id: null,
      root_id: docId,
      type: 'document',
      content: opts.title,
      properties: docProperties,
      tags: initialTags,
      status: docStatus,
      sort: 0,
      level: 0,
      now,
    })

    blockIds = insertChildBlocks(db, {
      notebookId: opts.notebookId,
      rootId: docId,
      inputs,
      sortOffset: 0,
      now,
    })
  })()

  return { docId, blockIds, parsedCount: inputs.length }
}

export interface AppendMarkdownToDocOptions {
  docId: string
  notebookId: string
  markdown: string
}

export interface AppendMarkdownToDocResult {
  /** 实际入库的 block id（顺序 = 插入顺序） */
  blockIds: string[]
  /** 解析入库的 block 数量（= blockIds.length） */
  parsedCount: number
}

/**
 * 向已有文档末尾追加 Markdown（解析为结构化 block 树入库）。
 *
 * 与 insertDocFromMarkdown 的区别：
 * - 不新建 document 根、不做 stripTitleHeading（追加内容的标题是用户显式写的）
 * - 顶层块 sort 接在当前最大 sort 之后，嵌套块沿解析顺序递增
 */
export function appendMarkdownToDoc(
  db: Db,
  opts: AppendMarkdownToDocOptions,
): AppendMarkdownToDocResult {
  const inputs = parseMarkdownToBlocks(opts.markdown, opts.notebookId)

  const maxSort = getMaxChildSort(db, opts.docId)
  const now = nowTimestamp()

  let blockIds: string[] = []
  db.transaction(() => {
    db.run('PRAGMA defer_foreign_keys = ON')
    blockIds = insertChildBlocks(db, {
      notebookId: opts.notebookId,
      rootId: opts.docId,
      inputs,
      sortOffset: maxSort + 1,
      now,
    })
  })()

  return { blockIds, parsedCount: inputs.length }
}

export interface InsertChildBlocksOptions {
  notebookId: string
  /** 文档根 block id（顶层块的 parent_id / 全部块的 root_id） */
  rootId: string
  inputs: CreateBlockInput[]
  /** 起始 sort（追加场景接在当前最大 sort 之后） */
  sortOffset: number
  now: string
}

/** 把解析出的 block 树插入为 rootId 的子块，返回实际入库的 block id（插入顺序） */
export function insertChildBlocks(db: Db, opts: InsertChildBlocksOptions): string[] {
  const blockIds: string[] = []

  // inp.id → 实际 blockId 映射表；父对子的引用必须走这条映射。
  // 否则 inp.parent_id 指向 parseMarkdownToBlocks 产生的临时 UUID
  // （从未 INSERT），嵌套块会触发 immediate FK 失败。
  const idMap = new Map<string, string>()
  // 临时 id → input，用于沿父链计算真实 level
  const byTempId = new Map<string, CreateBlockInput>()
  for (const inp of opts.inputs) {
    if (inp.id) byTempId.set(inp.id, inp)
  }
  const levelOf = (inp: CreateBlockInput): number => {
    // 沿临时父链向上走，每穿一层 +1（seen 防环）
    let level = 1
    const seen = new Set<string>()
    let p = inp.parent_id
    while (p && byTempId.has(p) && !seen.has(p)) {
      seen.add(p)
      level++
      p = byTempId.get(p)!.parent_id
    }
    return level
  }

  for (let i = 0; i < opts.inputs.length; i++) {
    const inp = opts.inputs[i]
    const blockId = crypto.randomUUID()
    if (inp.id) idMap.set(inp.id, blockId)
    // 父链映射：从临时 id 翻译成已经 INSERT 的实际 id
    const parentId = inp.parent_id
      ? (idMap.get(inp.parent_id) ?? opts.rootId)
      : opts.rootId

    insertBlock(db, {
      id: blockId,
      notebook_id: opts.notebookId,
      parent_id: parentId as string,
      root_id: opts.rootId,
      type: inp.type,
      content: inp.content ?? '',
      properties: JSON.stringify(inp.properties || {}),
      sort: opts.sortOffset + i,
      level: levelOf(inp),
      now: opts.now,
    })
    blockIds.push(blockId)
  }

  return blockIds
}
