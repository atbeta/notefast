/**
 * WebDAV Sync Adapter — Markdown 单向归档
 */

import {
  type SyncAdapter,
  type SyncInfo,
  type SyncResult,
  type PushOptions,
  type WebDavLocationConfig,
} from '@notefast/core'
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

export interface WebDavClientLike {
  send(input: {
    method: string
    url: string
    body?: string | Uint8Array
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
        body: body as BodyInit,
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
          await ensureCollections(client, base, rootPath, `${keyPrefix}media/`)
          const existing = new Set(await listMediaKeys(client, base, rootPath, `${keyPrefix}media/`))
          for (const [sha, rel] of mediaRefs) {
            const key = `${keyPrefix}${rel}`
            if (existing.has(key)) continue
            const bytes = readAssetBytes(sha)
            if (!bytes) continue
            const put = await client.send({
              method: 'PUT',
              url: joinUrl(base, rootPath, key),
              body: bytes,
              headers: { 'Content-Type': 'application/octet-stream' },
            })
            if (put.status < 200 || put.status >= 300) {
              result.errors.push(`media ${sha}: PUT ${put.status}`)
            }
          }
        } catch (e) {
          result.errors.push(`media: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // 重写 asset: 引用为相对路径后上传文档
      for (const p of pending) {
        try {
          const markdown = rewriteAssetRefs(p.markdown, mediaRefs)
          const ok = await ensureCollections(client, base, rootPath, keyPrefix)
          if (!ok) {
            result.errors.push(`${p.docId}: MKCOL 失败`)
            continue
          }
          const put = await client.send({
            method: 'PUT',
            url: joinUrl(base, rootPath, p.key),
            body: markdown,
            headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
          })
          if (put.status >= 200 && put.status < 300) {
            files.push({ docId: p.docId, title: p.title, filename: p.filename, key: p.key })
            result.pushed++
          } else {
            result.errors.push(`${p.docId}: PUT ${put.status} ${put.body.slice(0, 80)}`)
          }
        } catch (e) {
          result.errors.push(`${p.docId}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      if (!docIds || docIds.length === 0) {
        const manifest = buildArchiveManifest({ adapter: 'webdav', files, media: [...mediaRefs.values()] })
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
        const staleMedia = staleArchiveMedia(previous, manifest)
        for (const rel of staleMedia) {
          try {
            const del = await client.send({
              method: 'DELETE',
              url: joinUrl(base, rootPath, `${keyPrefix}${rel}`),
            })
            if (del.status >= 400 && del.status !== 404) {
              result.errors.push(`delete ${rel}: ${del.status}`)
            }
          } catch (e) {
            result.errors.push(`delete ${rel}: ${e instanceof Error ? e.message : String(e)}`)
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

  /** 列出指定目录下的文件相对键（PROPFIND Depth:1 解析 href） */
  async function listMediaKeys(
    client: WebDavClientLike,
    base: string,
    rootPath: string,
    dirPrefix: string,
  ): Promise<string[]> {
    const propfindBody =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>'
    const res = await client.send({
      method: 'PROPFIND',
      url: joinUrl(base, rootPath, `/${dirPrefix.replace(/\/+$/, '')}/`),
      body: propfindBody,
      headers: { 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' },
    })
    if (res.status !== 207 && res.status !== 200) return []
    const keys: string[] = []
    for (const m of res.body.match(/<[^>]*:?href[^>]*>([^<]+)<\/[^>]*:?href>/gi) || []) {
      const href = m.replace(/<[^>]*:?href[^>]*>/, '').replace(/<\/[^>]*:?href>/, '').trim()
      const decoded = decodeURIComponent(href.split('/').pop() ?? '')
      if (decoded) keys.push(`${dirPrefix}${decoded}`)
    }
    return keys
  }
}
