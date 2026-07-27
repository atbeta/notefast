/**
 * 分享公开端点（无鉴权）
 *
 * 挂在 /api/* 之外：authMiddleware 只覆盖 /api/*，公开路径天然绕开；
 * 全局 rate limit（app.use('*')）仍覆盖这些路径。
 *
 * - GET /share/:token              → 文档只读内容（title + markdown）
 * - GET /share/:token/assets/:sha  → 文档引用的图片（引用扫描校验，非全站代理）
 *
 * 失效语义：token 无效（从未开启 / 已关闭 / 已重开）一律 404，
 * 不暴露任何存在性信息。
 */

import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { buildBlockTree, blocksToMarkdown } from '@notefast/core'
import { getDb } from '../db'
import { fetchDocBlocks } from '../store/blocks'
import { getShareByToken } from '../store/shares'
import { extractAssetRefs, readAsset } from '../assets/store'

const sharePublic = new Hono()

/** token → 有效分享的行；无效一律走 404（调用方统一文案） */
function resolveShare(token: string) {
  // 粗过滤：token 定长 32 hex，避免无谓的数据库扫描与注入面
  if (!/^[0-9a-f]{32}$/.test(token)) return null
  return getShareByToken(getDb(), token)
}

sharePublic.get('/:token', (c) => {
  const share = resolveShare(c.req.param('token'))
  if (!share) {
    return c.json({ error: 'not_found', message: '链接不存在或已关闭' }, 404)
  }

  const db = getDb()
  const rows = fetchDocBlocks(db, share.doc_id)
  if (rows.length === 0) {
    // 文档已删除（分享记录随软删除失去意义，对外同样 404）
    return c.json({ error: 'not_found', message: '链接不存在或已关闭' }, 404)
  }

  const tree = buildBlockTree(rows)
  const docRow = rows.find((r) => r.id === share.doc_id)!
  // no-store：过期/关闭语义要求每次回源，不给反代/CDN 缓存旧内容的机会
  return c.json({
    title: docRow.content,
    markdown: blocksToMarkdown(tree),
    updated_at: docRow.updated_at,
    shared_at: share.created_at,
  }, 200, { 'Cache-Control': 'no-store' })
})

sharePublic.get('/:token/assets/:sha256', (c) => {
  const share = resolveShare(c.req.param('token'))
  if (!share) {
    return c.json({ error: 'not_found', message: '链接不存在或已关闭' }, 404)
  }

  // 引用校验：asset 必须确实被此文档引用，否则该端点会退化为全站 asset 代理
  const sha = c.req.param('sha256')
  const db = getDb()
  const rows = fetchDocBlocks(db, share.doc_id)
  // 单次扫描：拼一次内容跑一遍正则，不逐块重复编译匹配
  const allContent = rows.map((r) => r.content).join('\n')
  if (!extractAssetRefs(allContent).includes(sha)) {
    return c.json({ error: 'not_found', message: '图片不存在' }, 404)
  }

  const found = readAsset(sha)
  if (!found) {
    return c.json({ error: 'not_found', message: '图片不存在' }, 404)
  }

  const bytes = readFileSync(found.path)
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': found.meta.mime,
      // 内容寻址：sha 即内容哈希，永不变化，可永久缓存。
      // 不写 Content-Length：交由 Bun/反代（可能启 gzip）自行处理
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

export default sharePublic
