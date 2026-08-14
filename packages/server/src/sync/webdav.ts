/**
 * WebDAV Sync Adapter — Markdown 单向归档
 *
 * 存储操作经 ObjectStore 抽象层（createWebDavObjectStore），推送流程与
 * S3 / LocalFS 共用 sync/archivePush 的 pushArchiveViaStore；
 * info()（PROPFIND 探测）保留在适配器内。
 */

import {
  type SyncAdapter,
  type SyncInfo,
  type SyncResult,
  type PushOptions,
  type WebDavLocationConfig,
} from '@notefast/core'
import {
  createWebDavHttpClient,
  createWebDavObjectStore,
  splitWebDavBaseUrl,
  type WebDavHttpClient,
} from '../storage/webdavStore'
import { pushArchiveViaStore } from './archivePush'

export type WebDavClientLike = WebDavHttpClient

export interface CreateWebDavAdapterOptions {
  client?: WebDavClientLike
  fetchImpl?: typeof fetch
}

function normalizePrefix(prefix?: string): string {
  if (!prefix) return ''
  const p = prefix.replace(/^\/+|\/+$/g, '')
  return p === '' ? '' : p + '/'
}

export function createDefaultClient(
  webdav: WebDavLocationConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): WebDavClientLike {
  return createWebDavHttpClient(webdav, fetchImpl)
}

function joinUrl(base: string, rootPath: string, target: string): string {
  const b = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
  const c = target.startsWith('/') ? target : '/' + target
  return `${base}${b}${c}`.replace(/([^:]\/)\/+/g, '$1')
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
  const { base, rootPath } = splitWebDavBaseUrl(webdav.endpoint)
  const basePrefix = normalizePrefix(prefix)
  const store = createWebDavObjectStore(webdav, opts.client, opts.fetchImpl)

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
      return pushArchiveViaStore(store, 'webdav', basePrefix, options)
    },
  }
}
