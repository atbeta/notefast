import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
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
  listBlockRevisions,
  getBlockRevision,
  nowTimestamp,
} from '../store/blocks'
import { deleteRefsTouchingBlocks } from '../store/refs'
import { deleteMentionsTouchingBlocks } from '../store/entities'
import { deleteSharesByDocIds } from '../store/shares'
import { fireAfterCreate, fireAfterUpdate, fireAfterDelete } from '../services/hooks'
import { applyAiExcludeChange } from '../ai/aiExclude'
import { reanalyzeDoc } from '../ai/autoLink'
import { scheduleDocIndex } from '../ai/indexJobs'
import { scheduleSyncNow } from '../sync/protocolManager'

const blocks = new Hono()

/** 回退 revision 的请求体：仅 actor 可选（记录回退来源，缺省 'revert'） */
const restoreRevisionSchema = z.object({
  actor: z.string().max(40).optional(),
})

// 回收站：最近软删除的 block 列表。
// 必须注册在 /:id 之前，否则 'deleted' 被当作 block id。
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
  // 块写入后去抖自动同步（fire-and-forget，未配置同步时静默跳过）
  scheduleSyncNow()
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

  scheduleSyncNow()
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
  scheduleSyncNow()
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
    deleteMentionsTouchingBlocks(db, allIds)
    softDeleteBlocks(db, allIds)
    // 删除文档根时切断公开链接（恢复不复活旧 token，需重新开启）
    if (existing.type === 'document') {
      deleteSharesByDocIds(db, [id])
    }
  })()

  fireAfterDelete(id)
  scheduleSyncNow()
  return c.json({ deleted: true, count: allIds.length })
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

  // 文档根恢复 = 重新进入流通：删除时向量被清、mentions 被物理 purge，
  // 补全 doc 重索引 + autoLink 重抽（均无 provider 时安全 no-op；
  // 分享旧链接按既定语义不复活，需重新开启）
  if (existing.type === 'document') {
    scheduleDocIndex(id, allIds)
    reanalyzeDoc(id)
  }

  scheduleSyncNow()
  return c.json({ restored: true, count: allIds.length })
})

/** 列出 block 的内容历史（新→旧）；软删除块的 revision 仍可查（回退/审计兜底） */
blocks.get('/:id/revisions', (c) => {
  const db = getDb()
  const id = c.req.param('id')
  // 非数字 limit（Number → NaN）会被传进 SQLite LIMIT 抛 500，守卫后回退默认值
  const limitRaw = Number(c.req.query('limit') ?? 50)
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 50

  const existing = getBlockById(db, id)
  if (!existing) {
    return c.json({ error: 'not_found', message: `Block ${id} 不存在` }, 404)
  }
  const revisions = listBlockRevisions(db, id, limit)
  return c.json({ block_id: id, revisions })
})

/** 回退到指定 revision：把该版本内容写回（走 updateBlock，自动记为一次新修订 + 索引 + hooks） */
blocks.post(
  '/:id/revisions/:rev/restore',
  zValidator('json', restoreRevisionSchema),
  (c) => {
    const db = getDb()
    const id = c.req.param('id')
    const rev = Number(c.req.param('rev'))
    const input = c.req.valid('json')

    const existing = getBlockById(db, id)
    if (!existing) {
      return c.json({ error: 'not_found', message: `Block ${id} 不存在` }, 404)
    }
    if (!Number.isInteger(rev) || rev < 1) {
      return c.json({ error: 'invalid_params', message: `rev 必须是正整数` }, 400)
    }
    const revision = getBlockRevision(db, id, rev)
    if (!revision) {
      return c.json({ error: 'not_found', message: `Block ${id} 的 revision ${rev} 不存在` }, 404)
    }

    updateBlock(db, id, { content: revision.content, actor: input.actor ?? 'revert' })

    const block = rowToBlock(getBlockById(db, id)!)
    fireAfterUpdate(block)
    scheduleSyncNow()
    return c.json({ restored: true, rev, block })
  },
)

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
