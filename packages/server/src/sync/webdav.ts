/**
 * WebDAV Sync Adapter — Markdown 单向归档
 */

import {
  blocksToMarkdown,
  buildBlockTree,
  type SyncAdapter,
  type SyncInfo,
  type SyncResult,
  type PushOptions,
  type WebDavLocationConfig,
} from '@notefast/core'
import { getDb } from '../db'
import { fetchDocBlocks, listDocRows } from '../store/blocks'
import {
  ARCHIVE_MANIFEST_NAME,
  archiveFilename,
  buildArchiveManifest,
  isArchiveManifest,
  staleArchiveKeys,
  type ArchiveManifest,
} from './archive'

export interface WebDavClientLike {
  send(input: {
    method: string
    url: string
    body?: string
    headers?: Record<string, string>
  }): Promise<{ status: number; body: string; contentLength?: number }>
}

export interface CreateWebDavAdapterOptions {
  client?: WebDavClientLike
  fetchImpl?: typeof fetch
}

function splitBaseUrl(endpoint: string): { base: string; rootPath: string } {
  const e = endpoint.trim()
  const u = new URL(e)
  let pathname = u.pathname.replace(/\/+$/, '')
  if (pathname === '') pathname = '/'
  return {
    base: `${u.protocol}//${u.host}`,
    rootPath: pathname,
  }
}

function joinUrl(base: string, rootPath: string, target: string): string {
  const b = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
  const c = target.startsWith('/') ? target : '/' + target
  return `${base}${b}${c}`.replace(/([^:]\/)\/+/g, '$1')
}

function basicAuth(user: string, pass: string): string {
  const token = Buffer.from(`${user}:${pass}`, 'utf-8').toString('base64')
  return `Basic ${token}`
}

export function createDefaultClient(
  webdav: WebDavLocationConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): WebDavClientLike {
  const auth = basicAuth(webdav.username, webdav.password)
  const commonHeaders = {
    Authorization: auth,
    Accept: '*/*',
  }
  return {
    async send({ method, url, body, headers }) {
      const mergedHeaders = { ...commonHeaders, ...(headers || {}) }
      const res = await fetchImpl(url, {
        method,
        headers: mergedHeaders,
        body,
      })
      const text = await res.text().catch(() => '')
      return {
        status: res.status,
        body: text,
        contentLength: parseInt(res.headers.get('content-length') || '', 10) || undefined,
      }
    },
  }
}

function normalizePrefix(prefix?: string): string {
  if (!prefix) return ''
  const p = prefix.replace(/^\/+|\/+$/g, '')
  return p === '' ? '' : p + '/'
}

async function ensureCollections(
  client: WebDavClientLike,
  base: string,
  rootPath: string,
  prefix: string,
): Promise<boolean> {
  if (!prefix) return true
  const segments = prefix.replace(/\/+$/, '').split('/').filter(Boolean)
  let pathSoFar = ''
  for (const seg of segments) {
    pathSoFar += '/' + seg
    const url = joinUrl(base, rootPath, pathSoFar + '/')
    const res = await client.send({
      method: 'MKCOL',
      url,
      headers: {},
    })
    if (res.status >= 200 && res.status < 400) continue
    if (res.status === 405) continue
    return false
  }
  return true
}

export function createWebDavAdapter(
  webdav: WebDavLocationConfig,
  prefix: string,
  enabled: boolean,
  opts: CreateWebDavAdapterOptions = {},
): SyncAdapter {
  if (!enabled) throw new Error('WebDAV adapter not enabled')
  if (!webdav.endpoint || !webdav.endpoint.trim()) {
    throw new Error('WebDAV endpoint 不能为空')
  }
  if (!webdav.username || !webdav.password) {
    throw new Error('WebDAV username / password 必填')
  }

  const client: WebDavClientLike = opts.client ?? createDefaultClient(webdav, opts.fetchImpl)
  const { base, rootPath } = splitBaseUrl(webdav.endpoint)
  const basePrefix = normalizePrefix(prefix)

  async function loadPreviousManifest(prefix: string): Promise<ArchiveManifest | null> {
    const key = `${prefix}${ARCHIVE_MANIFEST_NAME}`
    const url = joinUrl(base, rootPath, key)
    const res = await client.send({ method: 'GET', url })
    if (res.status < 200 || res.status >= 300) return null
    try {
      const parsed = JSON.parse(res.body) as unknown
      return isArchiveManifest(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  return {
    name: 'webdav',

    async info(): Promise<SyncInfo> {
      const propfindBody =
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>'
      const target = basePrefix ? `/${basePrefix.replace(/\/$/, '')}/` : '/'
      const res = await client.send({
        method: 'PROPFIND',
        url: joinUrl(base, rootPath, target),
        body: propfindBody,
        headers: { 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' },
      })

      const reachable = res.status === 207 || res.status === 200
      let fileCount = 0
      if (reachable) {
        for (const m of res.body.match(/<[^>]*:?href[^>]*>([^<]+)<\/[^>]*:?href>/gi) || []) {
          const url1 = m.replace(/<[^>]*:?href[^>]*>/, '').replace(/<\/[^>]*:?href>/, '').trim()
          if (url1.toLowerCase().endsWith('.md')) fileCount++
        }
      }
      return {
        extra: {
          endpoint: webdav.endpoint,
          username: webdav.username ? '***set***' : '',
          prefix: basePrefix,
          reachable,
          status: res.status,
          fileCount,
        },
      }
    },

    async push(options?: PushOptions): Promise<SyncResult> {
      const db = getDb()
      const docIds = options?.docIds
      const keyPrefix = normalizePrefix(options?.prefix ?? basePrefix)

      // 归档镜像活库：软删除文档不导出（下次全量同步时经 manifest 清理远端陈旧文件）
      const docs = listDocRows(db, { docIds, order: 'updated_asc' })

      const result: SyncResult = { pushed: 0, pulled: 0, errors: [] }
      const files: ArchiveManifest['files'] = []
      const previous =
        !docIds || docIds.length === 0 ? await loadPreviousManifest(keyPrefix) : null

      for (const doc of docs) {
        try {
          const tree = buildBlockTree(fetchDocBlocks(db, doc.id))
          const markdown = blocksToMarkdown(tree)
          const filename = archiveFilename(doc.content || 'untitled', doc.id)
          const key = `${keyPrefix}${filename}`
          const fullUrl = joinUrl(base, rootPath, key)

          const ok = await ensureCollections(client, base, rootPath, keyPrefix)
          if (!ok) {
            result.errors.push(`${doc.id}: MKCOL 失败`)
            continue
          }

          const put = await client.send({
            method: 'PUT',
            url: fullUrl,
            body: markdown,
            headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
          })
          if (put.status >= 200 && put.status < 300) {
            files.push({
              docId: doc.id,
              title: doc.content || 'untitled',
              filename,
              key,
            })
            result.pushed++
          } else {
            result.errors.push(`${doc.id}: PUT ${put.status} ${put.body.slice(0, 80)}`)
          }
        } catch (e) {
          result.errors.push(`${doc.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      if (!docIds || docIds.length === 0) {
        const manifest = buildArchiveManifest({ adapter: 'webdav', files })
        const stale = staleArchiveKeys(previous, manifest)
        for (const key of stale) {
          try {
            const del = await client.send({
              method: 'DELETE',
              url: joinUrl(base, rootPath, key),
            })
            if (del.status >= 400 && del.status !== 404) {
              result.errors.push(`delete ${key}: ${del.status}`)
            }
          } catch (e) {
            result.errors.push(`delete ${key}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        const mUrl = joinUrl(base, rootPath, `${keyPrefix}${ARCHIVE_MANIFEST_NAME}`)
        const mPut = await client.send({
          method: 'PUT',
          url: mUrl,
          body: JSON.stringify(manifest, null, 2),
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })
        if (mPut.status < 200 || mPut.status >= 300) {
          result.errors.push(`manifest: PUT ${mPut.status}`)
        }
      }

      return result
    },
  }
}
