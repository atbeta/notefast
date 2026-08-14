/**
 * LocalFS Sync Adapter — Markdown 单向归档
 *
 * 存储操作经 ObjectStore 抽象层（createLocalFsObjectStore），推送流程与
 * S3 / WebDAV 共用 sync/archivePush 的 pushArchiveViaStore——
 * media（asset: → media/<sha> 相对路径）与 manifest 清理与远端适配器
 * 同语义，补上了此前 LocalFS 导出自包含性破缺（图片不落地）。
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  type SyncAdapter,
  type SyncInfo,
  type SyncResult,
  type PushOptions,
  type LocalFsAdapterConfig,
} from '@notefast/core'
import { getDb } from '../db'
import { countDocRows } from '../store/blocks'
import { createLocalFsObjectStore } from '../storage/webdavStore'
import { pushArchiveViaStore } from './archivePush'

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
  return countDocRows(db)
}

export function createLocalFsAdapter(cfg: LocalFsAdapterConfig): SyncAdapter {
  if (!cfg.enabled) {
    throw new Error('LocalFs adapter not enabled')
  }
  if (!cfg.dir || !cfg.dir.trim()) {
    throw new Error('LocalFs dir 不能为空')
  }

  const dir = cfg.dir
  const store = createLocalFsObjectStore(dir)

  return {
    name: 'localfs',

    async info(): Promise<SyncInfo> {
      const db = getDb()
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
      const prefix = (options?.prefix ?? cfg.prefix ?? '').trim()
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      } catch (e) {
        return { pushed: 0, pulled: 0, errors: [`mkdir 失败: ${e instanceof Error ? e.message : e}`] }
      }
      return pushArchiveViaStore(store, 'localfs', prefix, options)
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
