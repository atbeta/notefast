import { Hono } from 'hono'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db'
import { blocksToMarkdown, buildBlockTree } from '@notefast/core'
import type { BlockRow } from '@notefast/core'

const sync = new Hono()

sync.get('/export/markdown', (c) => {
  const db = getDb()
  const dir = process.env.AUTO_EXPORT_DIR

  if (!dir) {
    return c.json({ error: 'not_configured', message: '未配置 AUTO_EXPORT_DIR 环境变量' }, 400)
  }

  const docs = db.query('SELECT * FROM blocks WHERE type = ? ORDER BY updated_at ASC').all('document') as BlockRow[]
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const results: { id: string; title: string; file: string; error?: string }[] = []

  for (const doc of docs) {
    try {
      const rows = fetchDescendants(db, doc.id)
      const tree = buildBlockTree([doc, ...rows])
      const markdown = blocksToMarkdown(tree)
      const slug = sanitizeFilename(doc.content || 'untitled')
      const filename = `${slug}.md`
      writeFileSync(join(dir, filename), markdown, 'utf-8')
      results.push({ id: doc.id, title: doc.content, file: filename })
    } catch (e) {
      results.push({ id: doc.id, title: doc.content, file: '', error: String(e) })
    }
  }

  return c.json({ exported: results.length, files: results, dir })
})

function fetchDescendants(database: ReturnType<typeof getDb>, rootId: string): BlockRow[] {
  const rows: BlockRow[] = []
  const stack = [rootId]
  while (stack.length > 0) {
    const currentId = stack.pop()!
    const children = database.query('SELECT * FROM blocks WHERE parent_id = ? ORDER BY sort ASC').all(currentId) as BlockRow[]
    for (const child of children) { rows.push(child); stack.push(child.id) }
  }
  return rows
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'untitled'
}

export default sync
