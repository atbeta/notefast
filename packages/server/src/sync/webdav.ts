/**
 * WebDAV Sync Adapter
 *
 * 把 NoteFast 数据库里的所有文档渲染成 Markdown，并通过 WebDAV PUT
 * 推送到任何兼容服务器：
 *   - NextCloud (https://host/remote.php/webdav)
 *   - ownCloud
 *   - Apache + mod_dav
 *   - 群晖 Synology WebDAV Server
 *   - 极空间 / 飞牛 / 威联通 NAS 自带 WebDAV
 *   - macOS Finder / Windows 文件资源管理器（开启 WebDAV 客户端）
 *   - 坚果云（https://dav.jianguoyun.com/dav/）
 *
 * 设计：
 * - 纯 fetch 实现，不引入新 SDK；用 Basic Auth 头做认证
 * - push() 先 MKCOL 中间目录再 PUT；MKCOL 返回 405 也算成功（已存在）
 * - info() 走 PROPFIND 探测：返回 reachable + .md 文件数 + endpoint 元信息
 * - 测试通过 WebDavClientLike 接口注入 fake client，不碰真实服务器
 */

import {
  blocksToMarkdown,
  buildBlockTree,
  type SyncAdapter,
  type SyncInfo,
  type SyncResult,
  type PushOptions,
  type WebDavAdapterConfig,
  type BlockRow,
} from '@notefast/core'
import { getDb } from '../db'

/** 抽象的 WebDAV 调用接口（与 Web 形态兼容） */
export interface WebDavClientLike {
  send(input: {
    method: string
    url: string
    body?: string
    headers?: Record<string, string>
  }): Promise<{ status: number; body: string; contentLength?: number }>
}

/** 构造函数可通过 opts.client 注入 stub 客户端 */
export interface CreateWebDavAdapterOptions {
  client?: WebDavClientLike
  /** 默认 fetch，方便测试替换 */
  fetchImpl?: typeof fetch
}

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

/** trim 末尾斜杠并返回 origin + pathname 基地址 */
function splitBaseUrl(endpoint: string): { base: string; rootPath: string } {
  const e = endpoint.trim()
  const u = new URL(e)
  // pathname 不带 query / fragment；保留前导 /
  let pathname = u.pathname.replace(/\/+$/, '') // 末尾不要 /
  if (pathname === '') pathname = '/'
  return {
    base: `${u.protocol}//${u.host}`,
    rootPath: pathname,
  }
}

/** 拼接远端 URL：base + path（确保中间有 /） */
function joinUrl(base: string, rootPath: string, target: string): string {
  const a = base
  const b = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
  const c = target.startsWith('/') ? target : '/' + target
  // 多个斜杠并起来：只剩一个
  return `${a}${b}${c}`.replace(/([^:]\/)\/+/g, '$1')
}

/** Build Basic Auth header */
function basicAuth(user: string, pass: string): string {
  const token = Buffer.from(`${user}:${pass}`, 'utf-8').toString('base64')
  return `Basic ${token}`
}

/** 默认 fetch-based client */
export function createDefaultClient(
  cfg: WebDavAdapterConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): WebDavClientLike {
  const auth = basicAuth(cfg.username, cfg.password)
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

export function createWebDavAdapter(
  cfg: WebDavAdapterConfig,
  opts: CreateWebDavAdapterOptions = {},
): SyncAdapter {
  if (!cfg.enabled) throw new Error('WebDAV adapter not enabled')
  if (!cfg.endpoint || !cfg.endpoint.trim()) {
    throw new Error('WebDAV endpoint 不能为空')
  }
  if (!cfg.username || !cfg.password) {
    throw new Error('WebDAV username / password 必填')
  }

  const client: WebDavClientLike = opts.client ?? createDefaultClient(cfg, opts.fetchImpl)
  const { base, rootPath } = splitBaseUrl(cfg.endpoint)
  const basePrefix = normalizePrefix(cfg.prefix)

  return {
    name: 'webdav',

    async info(): Promise<SyncInfo> {
      // PROPFIND on root — many servers require Depth: 1 to list
      const propfindBody =
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>'
      const res = await client.send({
        method: 'PROPFIND',
        url: joinUrl(base, rootPath, '/'),
        body: propfindBody,
        headers: { 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' },
      })

      // 207 Multi-Status means WebDAV is responding.
      // Some servers (e.g. plain Apache) return 200 with the response XML.
      const reachable = res.status === 207 || res.status === 200
      let fileCount = 0
      if (reachable) {
        // 极简解析：数 <d:href> 或 <response> 个数，文件名以 .md 结尾
        const hrefs = res.body.match(/<[^>]*:?href[^>]*>[^<]*<\/[^>]*:?href>/gi) || []
        for (const m of res.body.match(/<[^>]*:?href[^>]*>([^<]+)<\/[^>]*:?href>/gi) || []) {
          const url1 = m.replace(/<[^>]*:?href[^>]*>/, '').replace(/<\/[^>]*:?href>/, '').trim()
          if (url1.toLowerCase().endsWith('.md')) fileCount++
        }
        void hrefs
      }
      return {
        extra: {
          endpoint: cfg.endpoint,
          username: cfg.username ? '***set***' : '',
          prefix: basePrefix,
          reachable,
          status: res.status,
          fileCount,
          extra: {
            responseBytes: res.body.length,
          },
        },
      }
    },

    async push(options?: PushOptions): Promise<SyncResult> {
      const db = getDb()
      const docIds = options?.docIds
      const prefix = normalizePrefix(options?.prefix ?? cfg.prefix)

      let sql = "SELECT * FROM blocks WHERE type = 'document'"
      const params: string[] = []
      if (docIds && docIds.length > 0) {
        sql += ` AND id IN (${docIds.map(() => '?').join(',')})`
        params.push(...docIds)
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
          const key = `${prefix}${slug}.md`
          const fullUrl = joinUrl(base, rootPath, key)

          // 推送：先确保每一层目录存在（MKCOL），然后 PUT
          const ok = await ensureCollections(client, base, rootPath, prefix, doc.id)
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
          // 201 Created or 204 No Content — successful PUT
          if (put.status >= 200 && put.status < 300) {
            result.pushed++
          } else {
            result.errors.push(`${doc.id}: PUT ${put.status} ${put.body.slice(0, 80)}`)
          }
        } catch (e) {
          result.errors.push(`${doc.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return result
    },
  }
}

/** Trim trailing slash from prefix (e.g. 'notes/' or '/notes/' → 'notes') */
function normalizePrefix(prefix?: string): string {
  if (!prefix) return ''
  const p = prefix.replace(/^\/+|\/+$/g, '')
  return p === '' ? '' : p + '/'
}

/** 给定 prefix（无尾 /）递归 MKCOL 各层目录。MKCOL 返回 405 / 301 都视为已存在 */
async function ensureCollections(
  client: WebDavClientLike,
  base: string,
  rootPath: string,
  prefix: string,
  // _docId 仅用于错误溯源
  _docId?: string,
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
    // 201 Created / 405 Method Not Allowed (already exists) / 301 Moved — 都视为成功
    if (res.status >= 200 && res.status < 400) continue
    if (res.status === 405) continue
    return false
  }
  return true
}
