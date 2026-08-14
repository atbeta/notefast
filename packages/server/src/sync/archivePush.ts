/**
 * 归档推送共享实现（S3 / WebDAV / LocalFS 三个适配器共用）——
 * 基于 ObjectStore 抽象层，不再各自手写 SDK 调用。
 *
 * 流程：构建每篇 markdown + 收集 media 引用（内容寻址去重）→ 上送缺失
 * media（asset: 重写为相对路径）→ 上送文档 → 全量推送时按 manifest 清理
 * 陈旧文档与 media → 写 manifest。
 */

import type { PushOptions, SyncResult } from '@notefast/core'
import { getDb } from '../db'
import { listDocRows } from '../store/blocks'
import { portableDocMarkdown } from '../services/portableMarkdown'
import { readAssetBytes } from '../assets/store'
import {
  ARCHIVE_MANIFEST_NAME,
  archiveFilename,
  buildArchiveManifest,
  isArchiveManifest,
  staleArchiveKeys,
  staleArchiveMedia,
  type ArchiveManifest,
} from './archive'
import { collectArchiveMediaRefs, rewriteAssetRefs } from './archiveMedia'
import { getObjectText, type ObjectStore } from '../storage/objectStore'

function normalizePrefix(prefix?: string): string {
  if (!prefix) return ''
  const p = prefix.replace(/^\/+|\/+$/g, '')
  return p === '' ? '' : p + '/'
}

async function loadPreviousManifest(
  store: ObjectStore,
  keyPrefix: string,
): Promise<ArchiveManifest | null> {
  const text = await getObjectText(store, `${keyPrefix}${ARCHIVE_MANIFEST_NAME}`)
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return isArchiveManifest(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function pushArchiveViaStore(
  store: ObjectStore,
  adapterName: 's3' | 'webdav' | 'localfs',
  basePrefix: string,
  options?: PushOptions,
): Promise<SyncResult> {
  const db = getDb()
  const docIds = options?.docIds
  const keyPrefix = normalizePrefix(options?.prefix ?? basePrefix)

  // 归档镜像活库：软删除文档不导出（下次全量同步时经 manifest 清理远端陈旧文件）
  const docs = listDocRows(db, { docIds, order: 'updated_asc' })

  const result: SyncResult = { pushed: 0, pulled: 0, errors: [] }
  const files: ArchiveManifest['files'] = []
  const previous =
    !docIds || docIds.length === 0 ? await loadPreviousManifest(store, keyPrefix) : null

  // 第一遍：构建每篇 markdown + 收集 media 引用（多文档共享内容寻址，去重）
  const pending: Array<{ docId: string; key: string; filename: string; title: string; markdown: string }> = []
  const mediaRefs = new Map<string, string>() // sha → relativeKey（media/<sha><ext>）
  for (const doc of docs) {
    try {
      const markdown = portableDocMarkdown(doc)
      for (const [sha, rel] of collectArchiveMediaRefs(markdown)) mediaRefs.set(sha, rel)
      const filename = archiveFilename(doc.content || 'untitled', doc.id)
      pending.push({ docId: doc.id, key: `${keyPrefix}${filename}`, filename, title: doc.content || 'untitled', markdown })
    } catch (e) {
      result.errors.push(`${doc.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 上送缺失的 media（内容寻址，仅补差）
  if (mediaRefs.size > 0) {
    try {
      const existing = new Set(await store.listObjects(`${keyPrefix}media/`))
      for (const [sha, rel] of mediaRefs) {
        const key = `${keyPrefix}${rel}`
        if (existing.has(key)) continue
        const bytes = readAssetBytes(sha)
        if (!bytes) continue
        await store.putObject(key, bytes)
      }
    } catch (e) {
      result.errors.push(`media: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 重写 asset: 引用为相对路径后上传文档
  for (const p of pending) {
    try {
      const markdown = rewriteAssetRefs(p.markdown, mediaRefs)
      await store.putObject(p.key, markdown, 'text/markdown; charset=utf-8')
      files.push({ docId: p.docId, title: p.title, filename: p.filename, key: p.key })
      result.pushed++
    } catch (e) {
      result.errors.push(`${p.filename}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 全量推送时才清理陈旧文件与 media（按文档过滤时不删）
  if (!docIds || docIds.length === 0) {
    const manifest = buildArchiveManifest({ adapter: adapterName, files, media: [...mediaRefs.values()] })
    const stale = staleArchiveKeys(previous, manifest)
    if (stale.length > 0) {
      const res = await store.deleteObjects(stale)
      for (const err of res.errors) result.errors.push(`delete: ${err}`)
    }
    const staleMedia = staleArchiveMedia(previous, manifest)
    if (staleMedia.length > 0) {
      const res = await store.deleteObjects(staleMedia.map((rel) => `${keyPrefix}${rel}`))
      for (const err of res.errors) result.errors.push(`delete: ${err}`)
    }
    try {
      await store.putObject(`${keyPrefix}${ARCHIVE_MANIFEST_NAME}`, JSON.stringify(manifest, null, 2), 'application/json; charset=utf-8')
    } catch (e) {
      result.errors.push(`manifest: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return result
}
