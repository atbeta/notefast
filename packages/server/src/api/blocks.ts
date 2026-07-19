import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import {
  createBlockSchema,
  updateBlockSchema,
  moveBlockSchema,
  rowToBlock,
  buildBlockTree,
} from '@notefast/core'
import type { BlockRow } from '@notefast/core'
import { getDb } from '../db'
import { fireAfterCreate, fireAfterUpdate, fireAfterDelete } from '../services/hooks'

const blocks = new Hono()

blocks.get('/:id', (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const depthParam = c.req.query('depth')
  const maxDepth = depthParam ? parseInt(depthParam, 10) : 3

  const row = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow | undefined
  if (!row) {
    return c.json({ error: 'not_found', message: `Block ${id} 不存在` }, 404)
  }

  const block = rowToBlock(row)
  const rows = fetchSubtree(db, id)

  if (rows.length > 0) {
    const children = limitDepth(buildBlockTree(rows), maxDepth, 0)
    block.children = children[0]?.children || buildBlockTree(rows)[0]?.children || []
  }

  return c.json(block)
})

blocks.get('/:id/tree', (c) => {
  const db = getDb()
  const id = c.req.param('id')

  const row = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow | undefined
  if (!row) {
    return c.json({ error: 'not_found', message: `Block ${id} 不存在` }, 404)
  }

  const rows = fetchSubtree(db, id)
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
    const parent = db.query('SELECT root_id, level FROM blocks WHERE id = ?').get(input.parent_id) as
      | { root_id: string; level: number }
      | undefined
    if (!parent) {
      return c.json({ error: 'not_found', message: `父块 ${input.parent_id} 不存在` }, 404)
    }
    rootId = parent.root_id
    level = parent.level + 1
  } else {
    rootId = id
    level = 0
  }

  const now = new Date().toISOString()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, sort, level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.notebook_id,
    input.parent_id || null,
    rootId,
    input.type,
    input.content || '',
    JSON.stringify(input.properties || {}),
    input.sort || 0,
    level,
    now,
    now,
  )

  const row = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow
  const block = rowToBlock(row)
  fireAfterCreate(block)
  return c.json(block, 201)
})

blocks.patch('/:id', zValidator('json', updateBlockSchema), (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const input = c.req.valid('json')

  const existing = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow | undefined
  if (!existing) {
    return c.json({ error: 'not_found', message: `Block ${id} 不存在` }, 404)
  }

  const updates: string[] = []
  const params: (string | number)[] = []

  if (input.content !== undefined) {
    updates.push('content = ?')
    params.push(input.content)
  }
  if (input.properties !== undefined) {
    updates.push('properties = ?')
    params.push(JSON.stringify(input.properties))
  }
  if (input.type !== undefined) {
    updates.push('type = ?')
    params.push(input.type)
  }

  if (updates.length === 0) {
    return c.json(rowToBlock(existing))
  }

  updates.push("updated_at = datetime('now')")
  params.push(id)

  db.query(`UPDATE blocks SET ${updates.join(', ')} WHERE id = ?`)
    .run(...params as [string, ...string[]])

  const row = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow
  const block = rowToBlock(row)
  fireAfterUpdate(block)
  return c.json(block)
})

blocks.patch('/:id/move', zValidator('json', moveBlockSchema), (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const input = c.req.valid('json')

  const existing = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow | undefined
  if (!existing) {
    return c.json({ error: 'not_found', message: `Block ${id} 不存在` }, 404)
  }

  let newRootId: string
  let newLevel: number

  if (input.new_parent_id) {
    const parent = db.query('SELECT root_id, level FROM blocks WHERE id = ?').get(input.new_parent_id) as
      | { root_id: string; level: number }
      | undefined
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

  db.query(
    `UPDATE blocks SET parent_id = ?, root_id = ?, level = level + ?,
     sort = COALESCE(?, sort), updated_at = datetime('now')
     WHERE id = ?`,
  ).run(input.new_parent_id, newRootId, levelDiff, input.new_sort ?? existing.sort, id)

  if (levelDiff !== 0) {
    db.transaction(() => {
      const descendants = fetchSubtree(db, id)
      const descendantIds = descendants.map((r) => r.id)
      if (descendantIds.length > 0) {
        const placeholders = descendantIds.map(() => '?').join(',')
        db.query(`UPDATE blocks SET level = level + ? WHERE id IN (${placeholders})`).run(levelDiff, ...descendantIds)
        db.query(`UPDATE blocks SET root_id = ? WHERE id IN (${placeholders})`).run(newRootId, ...descendantIds)
      }
    })()
  }

  const row = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow
  const block = rowToBlock(row)
  fireAfterUpdate(block)
  return c.json(block)
})

blocks.delete('/:id', (c) => {
  const db = getDb()
  const id = c.req.param('id')

  const existing = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow | undefined
  if (!existing) {
    return c.json({ error: 'not_found', message: `Block ${id} 不存在` }, 404)
  }

  const childIds = fetchSubtree(db, id)
  const allIds = [id, ...childIds.map((r) => r.id)]

  db.transaction(() => {
    for (const delId of allIds) {
      db.query('DELETE FROM block_refs WHERE source_id = ? OR target_id = ?').run(delId, delId)
    }
    const placeholders = allIds.map(() => '?').join(',')
    db.query(`DELETE FROM blocks WHERE id IN (${placeholders})`).run(...allIds)
  })()

  fireAfterDelete(id)
  return c.json({ deleted: true, count: allIds.length })
})

function fetchSubtree(database: ReturnType<typeof getDb>, rootId: string): BlockRow[] {
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
