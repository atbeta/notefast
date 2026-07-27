import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import {
  createBlockSchema,
  updateBlockSchema,
  moveBlockSchema,
  rowToBlock,
  buildBlockTree,
  readAiExclude,
} from '@notefast/core'
import { getDb } from '../db'
import {
  fetchSubtreeBlocks,
  fetchDeletedSubtreeIds,
  getBlockById,
  getLiveBlockById,
  getDeletedBlockById,
  getBlockAnchor,
  insertBlock,
  updateBlock,
  moveBlock,
  shiftDescendantLevels,
  reRootDescendants,
  softDeleteBlocks,
  restoreBlocks,
  listRecentlyDeletedBlocks,
  nowTimestamp,
} from '../store/blocks'
import { deleteRefsTouchingBlocks } from '../store/refs'
import { fireAfterCreate, fireAfterUpdate, fireAfterDelete } from '../services/hooks'
import { applyAiExcludeChange } from '../ai/aiExclude'

const blocks = new Hono()

blocks.get('/:id', (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const depthParam = c.req.query('depth')
  const maxDepth = depthParam ? parseInt(depthParam, 10) : 3

  const row = getBlockById(db, id)
  if (!row) {
    return c.json({ error: 'not_found', message: `Block ${id} 不存在` }, 404)
  }

  const block = rowToBlock(row)
  const rows = fetchSubtreeBlocks(db, id)

  if (rows.length > 0) {
    const children = limitDepth(buildBlockTree(rows), maxDepth, 0)
    block.children = children[0]?.children || buildBlockTree(rows)[0]?.children || []
  }

  return c.json(block)
})

blocks.get('/:id/tree', (c) => {
  const db = getDb()
  const id = c.req.param('id')

  const row = getBlockById(db, id)
  if (!row) {
    return c.json({ error: 'not_found', message: `Block ${id} 不存在` }, 404)
  }

  const rows = fetchSubtreeBlocks(db, id)
  const block = rowToBlock(row)
  const allRows = [row, ...rows]
  const tree = buildBlockTree(allRows)

  return c.json(tree.length > 0 ? tree[0] : block)
})

blocks.post('/', zValidator('json', createBlockSchema), (c) => {
  const db = getDb()
  const input = c.req.valid('json')
  const id = crypto.randomUUID()

  let rootId: string
  let level = 0

  if (input.parent_id) {
    const parent = getBlockAnchor(db, input.parent_id)
    if (!parent) {
      return c.json({ error: 'not_found', message: `父块 ${input.parent_id} 不存在` }, 404)
    }
    rootId = parent.root_id
    level = parent.level + 1
  } else {
    rootId = id
    level = 0
  }

  insertBlock(db, {
    id,
    notebook_id: input.notebook_id,
    parent_id: input.parent_id || null,
    root_id: rootId,
    type: input.type,
    content: input.content || '',
    sort: input.sort || 0,
    level,
    now: nowTimestamp(),
  })

  const block = rowToBlock(getBlockById(db, id)!)
  fireAfterCreate(block)
  return c.json(block, 201)
})

blocks.patch('/:id', zValidator('json', updateBlockSchema), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const input = c.req.valid('json')

  const existing = getBlockById(db, id)
  if (!existing) {
    return c.json({ error: 'not_found', message: `Block ${id} 不存在` }, 404)
  }

  // 仅当写入文档根的 properties 时检测 ai_exclude 切换，确保与专用端点行为一致
  const oldAiExclude =
    existing.type === 'document' ? readAiExclude(existing) : false

  const patch: Parameters<typeof updateBlock>[2] = {}
  if (input.content !== undefined) {
    patch.content = input.content
  }
  if (input.properties !== undefined) {
    patch.properties = JSON.stringify(input.properties)
    const inputAiExclude = (input.properties as Record<string, unknown>).ai_exclude
    if (inputAiExclude !== undefined) {
      patch.ai_exclude = inputAiExclude ? 1 : 0
    }
  }
  if (input.type !== undefined) {
    patch.type = input.type
  }

  if (Object.keys(patch).length === 0) {
    return c.json(rowToBlock(existing))
  }

  updateBlock(db, id, patch)

  const block = rowToBlock(getBlockById(db, id)!)
  fireAfterUpdate(block)

  // 通用 PATCH 路径下应用 ai_exclude 切换的副作用（与 /docs/:id/ai-exclude 等价）
  if (existing.type === 'document' && input.properties !== undefined) {
    const inputAiExclude = (input.properties as Record<string, unknown>).ai_exclude === true
    if (oldAiExclude !== inputAiExclude) {
      await applyAiExcludeChange(id, oldAiExclude, inputAiExclude)
    }
  }

  return c.json(block)
})

blocks.patch('/:id/move', zValidator('json', moveBlockSchema), (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const input = c.req.valid('json')

  const existing = getBlockById(db, id)
  if (!existing) {
    return c.json({ error: 'not_found', message: `Block ${id} 不存在` }, 404)
  }

  let newRootId: string
  let newLevel: number

  if (input.new_parent_id) {
    const parent = getBlockAnchor(db, input.new_parent_id)
    if (!parent) {
      return c.json({ error: 'not_found', message: `目标父块 ${input.new_parent_id} 不存在` }, 404)
    }
    newRootId = parent.root_id
    newLevel = parent.level + 1
  } else {
    newRootId = id
    newLevel = 0
  }

  const levelDiff = newLevel - existing.level
  const rootChanged = newRootId !== existing.root_id

  moveBlock(db, id, {
    parentId: input.new_parent_id,
    rootId: newRootId,
    levelDiff,
    sort: input.new_sort ?? existing.sort,
  })

  // level 与 root_id 传播相互独立：跨文档同层移动时 levelDiff 为 0，但后代 root_id 仍须跟随
  if (levelDiff !== 0 || rootChanged) {
    db.transaction(() => {
      const descendantIds = fetchSubtreeBlocks(db, id).map((r) => r.id)
      if (levelDiff !== 0) {
        shiftDescendantLevels(db, descendantIds, levelDiff)
      }
      if (rootChanged) {
        reRootDescendants(db, descendantIds, newRootId)
      }
    })()
  }

  const block = rowToBlock(getBlockById(db, id)!)
  fireAfterUpdate(block)
  return c.json(block)
})

blocks.delete('/:id', (c) => {
  const db = getDb()
  const id = c.req.param('id')

  const existing = getLiveBlockById(db, id)
  if (!existing) {
    return c.json({ error: 'not_found', message: `Block ${id} 不存在` }, 404)
  }

  const childIds = fetchSubtreeBlocks(db, id)
  const allIds = [id, ...childIds.map((r) => r.id)]

  db.transaction(() => {
    deleteRefsTouchingBlocks(db, allIds)
    softDeleteBlocks(db, allIds)
  })()

  fireAfterDelete(id)
  return c.json({ deleted: true, count: allIds.length })
})

blocks.get('/deleted', (c) => {
  const db = getDb()
  const within = c.req.query('within') || '30d'
  const days = within === '30d' ? 30 : within === '7d' ? 7 : parseInt(within, 10) || 30
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const rows = listRecentlyDeletedBlocks(db, cutoff)

  return c.json(rows.map((r) => ({
    id: r.id,
    type: r.type,
    content: r.content,
    notebook_id: r.notebook_id,
    root_id: r.root_id,
    delete_id: r.delete_id,
    deleted_at: r.updated_at,
  })))
})

blocks.post('/:id/restore', (c) => {
  const db = getDb()
  const id = c.req.param('id')

  const existing = getDeletedBlockById(db, id)
  if (!existing) {
    return c.json({ error: 'not_found', message: '未找到可恢复的已删除 block' }, 404)
  }

  // 恢复整个子树
  const allIds = [id, ...fetchDeletedSubtreeIds(db, id)]
  restoreBlocks(db, allIds)

  return c.json({ restored: true, count: allIds.length })
})

function limitDepth(blocks: import('@notefast/core').Block[], maxDepth: number, current: number): import('@notefast/core').Block[] {
  if (current >= maxDepth) {
    return blocks.map((b) => ({ ...b, children: [] }))
  }
  return blocks.map((b) => ({
    ...b,
    children: limitDepth(b.children, maxDepth, current + 1),
  }))
}

export default blocks
