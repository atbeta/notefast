import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { blocksToMarkdown, buildBlockTree } from '@notefast/core'
import type { BlockRow } from '@notefast/core'
import { getDb } from '../db'

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'untitled'
}

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

export function startAutoExport(dir: string): void {
  setTimeout(() => { runExport(dir) }, 10_000)
  const interval = setInterval(() => { runExport(dir) }, 60 * 60 * 1000)
  process.on('SIGTERM', () => clearInterval(interval))
}

function runExport(dir: string): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const db = getDb()
    const docs = db.query('SELECT * FROM blocks WHERE type = ? ORDER BY updated_at ASC').all('document') as BlockRow[]
    let count = 0
    for (const doc of docs) {
      try {
        const rows = fetchDescendants(db, doc.id)
        const tree = buildBlockTree([doc, ...rows])
        const markdown = blocksToMarkdown(tree)
        const slug = sanitizeFilename(doc.content || 'untitled')
        writeFileSync(join(dir, `${slug}.md`), markdown, 'utf-8')
        count++
      } catch { /* skip individual doc errors */ }
    }
    console.log(`📁 Auto-export: ${count} docs → ${dir}`)
  } catch (e) {
    console.error('Auto-export failed:', e)
  }
}
