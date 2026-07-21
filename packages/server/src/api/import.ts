import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { importMarkdownSchema, parseMarkdownToBlocks, stripTitleHeading, rowToBlock } from '@notefast/core'
import type { BlockRow } from '@notefast/core'
import { getDb } from '../db'
import { fireAfterCreate, fireAfterCreateMany } from '../services/hooks'
import { extractAssetRefs, findMissingAssets } from '../assets/store'

const importRouter = new Hono()

importRouter.post('/markdown', zValidator('json', importMarkdownSchema), (c) => {
  const db = getDb()
  const input = c.req.valid('json')

  const rawInputs = parseMarkdownToBlocks(input.markdown, input.notebook_id)
  if (rawInputs.length === 0) {
    return c.json({ error: 'bad_request', message: '无法解析 Markdown 内容' }, 400)
  }
  const docId = crypto.randomUUID()
  const now = new Date().toISOString()
  const title = input.title || extractTitle(input.markdown) || '未命名文档'
  const inputs = stripTitleHeading(rawInputs, title)

  const insertedIds: string[] = []
  // inp.id → 实际 blockId 映射表；父对子的引用必须走这条映射。
  // 如果不映射，inp.parent_id 指向的是 parseMarkdownToBlocks 产生的
  // 临时 UUID（从未 INSERT），SQLite immediate FK 会报 CONSTRAINT。
  const idMap = new Map<string, string>()

  db.transaction(() => {
    // 安全网：PRAGMA 作用域限本事务，提交时检查 FK，避免 immediate 阶段炸开
    db.run('PRAGMA defer_foreign_keys = ON')

    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
    ).run(docId, input.notebook_id, docId, title, now, now)

    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i]
      const blockId = crypto.randomUUID()
      // 父链映射：从临时 id 翻译成已经 INSERT 的实际 id
      const parentId: string | null = inp.parent_id
        ? (idMap.get(inp.parent_id) ?? docId)
        : docId

      // 如果有临时 id，记下映射供后面的子节点引用
      if (inp.id) idMap.set(inp.id, blockId)

      db.query(
        `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, sort, level, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        blockId,
        inp.notebook_id,
        parentId,
        docId,
        inp.type,
        inp.content ?? '',
        JSON.stringify(inp.properties || {}),
        0,
        now,
        now,
      )

      insertedIds.push(blockId)
    }
  })()

  // Hook 触发（fire-and-forget）：先 doc，再批量子块
  const docRow = db.query('SELECT * FROM blocks WHERE id = ?').get(docId) as BlockRow
  fireAfterCreate(rowToBlock(docRow))
  if (insertedIds.length > 0) {
    const placeholders = insertedIds.map(() => '?').join(',')
    const childRows = db
      .query(`SELECT * FROM blocks WHERE id IN (${placeholders})`)
      .all(...insertedIds) as BlockRow[]
    fireAfterCreateMany(childRows.map(rowToBlock))
  }

  // asset 引用对账：悬空引用不阻断导入（可能来自其他实例的导出），但如实告知调用方
  const missingAssets = findMissingAssets(extractAssetRefs(input.markdown))

  return c.json(
    {
      doc: rowToBlock(docRow),
      block_count: insertedIds.length + 1,
      ...(missingAssets.length > 0 ? { missing_assets: missingAssets } : {}),
    },
    201,
  )
})

function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)/m)
  return match ? match[1].trim() : null
}

export default importRouter
