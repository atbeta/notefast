/**
 * LocalFS Sync Adapter — Markdown 单向归档
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync, unlinkSync } from 'node:fs'
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
import { fetchDocBlocks } from '../dbQueries'
import {
  ARCHIVE_MANIFEST_NAME,
  archiveFilename,
  buildArchiveManifest,
  isArchiveManifest,
  staleArchiveKeys,
  type ArchiveManifest,
} from './archive'

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

function loadPreviousManifest(dir: string): ArchiveManifest | null {
  const path = join(dir, ARCHIVE_MANIFEST_NAME)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return isArchiveManifest(parsed) ? parsed : null
  } catch {
    return null
  }
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
      const files: ArchiveManifest['files'] = []
      const previous =
        !options?.docIds || options.docIds.length === 0 ? loadPreviousManifest(dir) : null

      for (const doc of docs) {
        try {
          const tree = buildBlockTree(fetchDocBlocks(db, doc.id))
          const markdown = blocksToMarkdown(tree)
          const filename = archiveFilename(doc.content || 'untitled', doc.id)
          const outName = prefix ? `${prefix}${filename}` : filename
          writeFileSync(join(dir, outName), markdown, 'utf-8')
          files.push({
            docId: doc.id,
            title: doc.content || 'untitled',
            filename: outName,
            key: outName,
          })
          result.pushed++
        } catch (e) {
          result.errors.push(`${doc.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      if (!options?.docIds || options.docIds.length === 0) {
        const manifest = buildArchiveManifest({ adapter: 'localfs', files })
        const stale = staleArchiveKeys(previous, manifest)
        for (const key of stale) {
          try {
            unlinkSync(join(dir, key))
          } catch {
            /* ignore missing */
          }
        }
        writeFileSync(join(dir, ARCHIVE_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
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
