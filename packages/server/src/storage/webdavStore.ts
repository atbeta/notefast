/**
 * WebDAV ObjectStore 实现（对象存储抽象层的第二后端）
 *
 * key → URL 映射：joinUrl(base, rootPath, key)；PUT 前自动 MKCOL 缺失的父
 * 集合（内存缓存已创建的目录前缀，防每次 PUT 都发 MKCOL）。
 * listObjects 用 PROPFIND Depth:1（归档推送只列举 media/ 这类扁平目录，
 * 不做递归；WebDAV 无原生前缀列举语义，调用方不要依赖跨目录列举）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WebDavLocationConfig } from '@notefast/core'
import type { ObjectBody, ObjectStore } from './objectStore'

/** 供测试注入的裸 HTTP 客户端（与 sync/webdav.ts 的 WebDavClientLike 同形） */
export interface WebDavHttpClient {
  send(input: {
    method: string
    url: string
    body?: string | Uint8Array
    headers?: Record<string, string>
  }): Promise<{ status: number; body: string; contentLength?: number }>
}

export function splitWebDavBaseUrl(endpoint: string): { base: string; rootPath: string } {
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

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>'

/** 基于 fetch 的默认 WebDAV HTTP 客户端（Basic Auth，Accept 任意类型） */
export function createWebDavHttpClient(
  webdav: WebDavLocationConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): WebDavHttpClient {
  const auth = basicAuth(webdav.username, webdav.password)
  return {
    async send({ method, url, body, headers }) {
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: auth,
          Accept: '*/*',
          ...(headers || {}),
        },
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

export function createWebDavObjectStore(
  webdav: WebDavLocationConfig,
  injected?: WebDavHttpClient,
  fetchImpl: typeof fetch = globalThis.fetch,
): ObjectStore {
  const client: WebDavHttpClient = injected ?? createWebDavHttpClient(webdav, fetchImpl)

  const { base, rootPath } = splitWebDavBaseUrl(webdav.endpoint)
  /** 已确认存在的目录前缀（含根），putObject 不必重复 MKCOL */
  const ensuredDirs = new Set<string>([''])

  async function ensureParentDirs(key: string): Promise<void> {
    const segments = key.split('/').filter(Boolean)
    segments.pop() // 最后一段是文件名
    let pathSoFar = ''
    for (const seg of segments) {
      pathSoFar += '/' + seg
      if (ensuredDirs.has(pathSoFar)) continue
      const res = await client.send({
        method: 'MKCOL',
        url: joinUrl(base, rootPath, pathSoFar + '/'),
        headers: {},
      })
      if (res.status >= 200 && res.status < 400) {
        ensuredDirs.add(pathSoFar)
      } else if (res.status === 405) {
        ensuredDirs.add(pathSoFar) // 已存在（Method Not Allowed）
      } else {
        throw new Error(`MKCOL ${pathSoFar}: HTTP ${res.status}`)
      }
    }
  }

  return {
    async testConnection() {
      try {
        const res = await client.send({
          method: 'PROPFIND',
          url: joinUrl(base, rootPath, '/'),
          body: PROPFIND_BODY,
          headers: { 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' },
        })
        if (res.status !== 207 && res.status !== 200) {
          return { ok: false, error: `PROPFIND HTTP ${res.status}` }
        }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },

    async putObject(key, body: ObjectBody, contentType?: string) {
      await ensureParentDirs(key)
      const res = await client.send({
        method: 'PUT',
        url: joinUrl(base, rootPath, key),
        body,
        headers: { 'Content-Type': contentType ?? 'application/octet-stream' },
      })
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`PUT ${key}: HTTP ${res.status}`)
      }
    },

    async getObject(key) {
      const res = await client.send({ method: 'GET', url: joinUrl(base, rootPath, key) })
      if (res.status === 404) return undefined
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`GET ${key}: HTTP ${res.status}`)
      }
      return new TextEncoder().encode(res.body) as Uint8Array
    },

    async listObjects(prefix) {
      const dir = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
      const res = await client.send({
        method: 'PROPFIND',
        url: joinUrl(base, rootPath, `/${dir.replace(/^\/+/, '')}/`),
        body: PROPFIND_BODY,
        headers: { 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' },
      })
      if (res.status !== 207 && res.status !== 200) return []
      const keys: string[] = []
      for (const m of res.body.match(/<[^>]*:?href[^>]*>([^<]+)<\/[^>]*:?href>/gi) || []) {
        const href = m.replace(/<[^>]*:?href[^>]*>/, '').replace(/<\/[^>]*:?href>/, '').trim()
        const name = decodeURIComponent(href.split('/').pop() ?? '')
        if (name && !name.endsWith('/')) keys.push(prefix.endsWith('/') ? `${prefix}${name}` : `${prefix}/${name}`)
      }
      return keys
    },

    async deleteObject(key) {
      const res = await client.send({ method: 'DELETE', url: joinUrl(base, rootPath, key) })
      if (res.status >= 400 && res.status !== 404) {
        throw new Error(`DELETE ${key}: HTTP ${res.status}`)
      }
    },

    async deleteObjects(keys) {
      let deleted = 0
      const errors: string[] = []
      for (const key of keys) {
        try {
          await this.deleteObject(key)
          deleted++
        } catch (e) {
          errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return { deleted, errors }
    },
  }
}

/**
 * LocalFS ObjectStore 实现（第三后端）：根目录 → key 空间。
 * putObject 自动建父目录；listObjects 递归走根目录按前缀过滤
 * （本地目录遍历廉价，归档清理场景目录深度浅）。
 */
export function createLocalFsObjectStore(rootDir: string): ObjectStore {
  const resolve = (key: string): string => join(rootDir, key)

  function walk(dir: string, out: string[]): string[] {
    if (!existsSync(dir)) return out
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, out)
      else if (entry.isFile()) out.push(full)
    }
    return out
  }

  return {
    async testConnection() {
      try {
        if (!existsSync(rootDir)) mkdirSync(rootDir, { recursive: true })
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },

    async putObject(key, body: ObjectBody, _contentType?: string) {
      const path = resolve(key)
      if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body)
    },

    async getObject(key) {
      const path = resolve(key)
      if (!existsSync(path)) return undefined
      return new Uint8Array(readFileSync(path))
    },

    async listObjects(prefix) {
      const rootLen = rootDir.replace(/\/+$/, '').length + 1
      return walk(rootDir, [])
        .map((f) => f.slice(rootLen))
        .filter((k) => k.startsWith(prefix))
    },

    async deleteObject(key) {
      try {
        if (existsSync(resolve(key))) unlinkSync(resolve(key))
      } catch {
        /* 不存在静默成功 */
      }
    },

    async deleteObjects(keys) {
      let deleted = 0
      const errors: string[] = []
      for (const key of keys) {
        try {
          await this.deleteObject(key)
          deleted++
        } catch (e) {
          errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return { deleted, errors }
    },
  }
}
