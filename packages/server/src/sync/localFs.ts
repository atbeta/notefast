/**
 * LocalFS Sync Adapter
 *
 * 把 NoteFast 数据库里的所有文档渲染成 Markdown 文件，写入本地目录。
 * 这是最简单、零依赖的 sync 形式——直接复用 blocksToMarkdown 流水线。
 *
 * 设计：
 * - 实现 core 里的 SyncAdapter 接口
 * - 名字为 'localfs'
 * - push() 全量覆盖；与 autoExport 的差异：写入前先做一次 sanity check（mkdir）
 * - 通过 Sanitize 文件名保证跨平台可用
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  blocksToMarkdown,
  buildBlockTree,
  type SyncAdapter,
  type SyncInfo,
  type SyncResult,
  type PushOptions,
  type LocalFsAdapterConfig,
  type BlockRow,
} from '@notefast/core'
import { getDb } from '../db'

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'untitled'
}

function fetchDescendants(database: ReturnType<typeof getDb>, rootId: string): BlockRow[] {
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

function countMdFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  const names = readdirSync(dir)
  let n = 0
  for (const n2 of names) {
    if (!n2.endsWith('.md')) continue
    try {
      const s = statSync(join(dir, n2))
      if (s.isFile()) n++
    } catch {
      /* ignore */
    }
  }
  return n
}

function countDocs(db: ReturnType<typeof getDb>): number {
  const row = db.query("SELECT count(*) as c FROM blocks WHERE type = 'document'").get() as { c: number }
  return row?.c ?? 0
}

export function createLocalFsAdapter(cfg: LocalFsAdapterConfig): SyncAdapter {
  if (!cfg.enabled) {
    throw new Error('LocalFs adapter not enabled')
  }
  if (!cfg.dir || !cfg.dir.trim()) {
    throw new Error('LocalFs dir 不能为空')
  }

  return {
    name: 'localfs',

    async info(): Promise<SyncInfo> {
      const db = getDb()
      const dir = cfg.dir
      const exists = existsSync(dir)
      return {
        lastSyncAt: undefined,
        remoteDocCount: exists ? countMdFiles(dir) : 0,
        extra: {
          dir,
          exists,
          writable: exists ? true : tryMkdir(dir),
          localDocs: countDocs(db),
        },
      }
    },

    async push(options?: PushOptions): Promise<SyncResult> {
      const dir = cfg.dir
      const prefix = (options?.prefix ?? cfg.prefix ?? '').trim()
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      } catch (e) {
        return { pushed: 0, pulled: 0, errors: [`mkdir 失败: ${e instanceof Error ? e.message : e}`] }
      }

      const db = getDb()
      let sql = "SELECT * FROM blocks WHERE type = 'document'"
      const params: string[] = []
      if (options?.docIds && options.docIds.length > 0) {
        const placeholders = options.docIds.map(() => '?').join(',')
        sql += ` AND id IN (${placeholders})`
        params.push(...options.docIds)
      }
      sql += ' ORDER BY updated_at ASC'
      const docs = db.query(sql).all(...params) as BlockRow[]
      const result: SyncResult = { pushed: 0, pulled: 0, errors: [] }
      for (const doc of docs) {
        try {
          const rows = fetchDescendants(db, doc.id)
          const tree = buildBlockTree([doc, ...rows])
          const markdown = blocksToMarkdown(tree)
          const slug = sanitizeFilename(doc.content || 'untitled')
          const filename = prefix ? `${prefix}${slug}.md` : `${slug}.md`
          writeFileSync(join(dir, filename), markdown, 'utf-8')
          result.pushed++
        } catch (e) {
          result.errors.push(`${doc.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return result
    },
  }
}

function tryMkdir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}
