/**
 * 整篇 Markdown 保存：按指纹对齐旧子块，只 insert/update/delete 差值，保留稳定 id。
 */

import type { BlockRow, CreateBlockInput } from '@notefast/core'
import type { getDb } from '../db'
import {
  insertBlock,
  nowTimestamp,
  overwriteChildBlock,
  softDeleteBlocks,
  touchDocRoot,
} from '../store/blocks'
import { fingerprintBlock, planBlockAlign, stablePropsJson } from './blockAlign'

type Db = ReturnType<typeof getDb>

export interface SyncMarkdownChildrenResult {
  insertedIds: string[]
  deletedIds: string[]
  /** 正文或 properties 变了的既有块（需重索引） */
  updatedIds: string[]
}

function levelOf(inp: CreateBlockInput, byTempId: Map<string, CreateBlockInput>): number {
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

export function syncMarkdownChildren(
  db: Db,
  opts: {
    notebookId: string
    rootId: string
    inputs: CreateBlockInput[]
    oldChildren: BlockRow[]
  },
): SyncMarkdownChildrenResult {
  const oldChildren = [...opts.oldChildren].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
  const oldFps = oldChildren.map((r) => fingerprintBlock(r.type, r.content, stablePropsJson(r.properties)))
  const newFps = opts.inputs.map((inp) =>
    fingerprintBlock(inp.type, inp.content ?? '', stablePropsJson(inp.properties)),
  )
  const ops = planBlockAlign(
    oldFps,
    newFps,
    oldChildren.map((r) => r.type),
    opts.inputs.map((inp) => inp.type),
  )

  const byTempId = new Map<string, CreateBlockInput>()
  for (const inp of opts.inputs) {
    if (inp.id) byTempId.set(inp.id, inp)
  }

  const idMap = new Map<string, string>()
  const newIndexToId = new Map<number, string>()
  const insertedIds: string[] = []
  const deletedIds: string[] = []
  const updatedIds: string[] = []
  const now = nowTimestamp()

  for (const op of ops) {
    if (op.kind === 'keep') {
      const inp = opts.inputs[op.newIndex]!
      const old = oldChildren[op.oldIndex]!
      newIndexToId.set(op.newIndex, old.id)
      if (inp.id) idMap.set(inp.id, old.id)
    } else if (op.kind === 'insert') {
      const inp = opts.inputs[op.newIndex]!
      const blockId = crypto.randomUUID()
      newIndexToId.set(op.newIndex, blockId)
      if (inp.id) idMap.set(inp.id, blockId)
      insertedIds.push(blockId)
    } else {
      deletedIds.push(oldChildren[op.oldIndex]!.id)
    }
  }

  const resolveParent = (inp: CreateBlockInput): string =>
    inp.parent_id ? (idMap.get(inp.parent_id) ?? opts.rootId) : opts.rootId

  db.run('PRAGMA defer_foreign_keys = ON')

  for (const op of ops) {
    if (op.kind !== 'insert') continue
    const inp = opts.inputs[op.newIndex]!
    const id = newIndexToId.get(op.newIndex)!
    insertBlock(db, {
      id,
      notebook_id: opts.notebookId,
      parent_id: resolveParent(inp),
      root_id: opts.rootId,
      type: inp.type,
      content: inp.content ?? '',
      properties: stablePropsJson(inp.properties),
      sort: op.newIndex,
      level: levelOf(inp, byTempId),
      now,
      touchRoot: false,
    })
  }

  for (const op of ops) {
    if (op.kind !== 'keep') continue
    const inp = opts.inputs[op.newIndex]!
    const old = oldChildren[op.oldIndex]!
    const parentId = resolveParent(inp)
    const content = inp.content ?? ''
    const properties = stablePropsJson(inp.properties)
    const level = levelOf(inp, byTempId)
    const sort = op.newIndex
    const changed =
      op.contentChanged
      || old.parent_id !== parentId
      || old.sort !== sort
      || old.level !== level
      || old.type !== inp.type
      || old.content !== content
      || stablePropsJson(old.properties) !== properties
    if (!changed) continue
    overwriteChildBlock(db, {
      id: old.id,
      parent_id: parentId,
      type: inp.type,
      content,
      properties,
      sort,
      level,
    })
    if (op.contentChanged || old.content !== content || stablePropsJson(old.properties) !== properties) {
      updatedIds.push(old.id)
    }
  }

  softDeleteBlocks(db, deletedIds)
  if (insertedIds.length > 0 || updatedIds.length > 0 || deletedIds.length > 0) {
    touchDocRoot(db, opts.rootId)
  } else {
    // 子块未动也要让文档根反映这次保存（标题可能已在外层 bump）
    touchDocRoot(db, opts.rootId)
  }

  return { insertedIds, deletedIds, updatedIds }
}
