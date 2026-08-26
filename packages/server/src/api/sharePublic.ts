/**
 * 分享公开端点（无鉴权）
 *
 * 挂在 /api/* 之外：authMiddleware 只覆盖 /api/*，公开路径天然绕开；
 * 全局 rate limit（app.use('*')）仍覆盖这些路径。
 *
 * - GET /share/:token              → 文档只读内容（title + markdown + asset_remote 外链映射）
 * - GET /share/:token/assets/:sha  → 文档引用的图片（引用扫描校验，非全站代理）
 *
 * 图片渲染：已上传图床的 asset 经 asset_remote 映射直接用图床 URL（前端重写），
 * 未外链的走 /assets/:sha 公开端点。
 *
 * 失效语义：token 无效（从未开启 / 已关闭 / 已重开）一律 404，
 * 不暴露任何存在性信息。
 */

import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { buildBlockTree, blocksToMarkdown, type Block } from '@notefast/core'
import { getDb } from '../db'
import { fetchDocBlocks } from '../store/blocks'
import { getShareByToken } from '../store/shares'
import { getChangesAnchor, contentRevisionToken } from '../store/changeFeed'
import { extractAssetRefs, getAssetRemoteUrl, readAsset } from '../assets/store'

const sharePublic = new Hono()

/** 公开面的树净化：剥掉 properties.source（导入来源可能是内网/私密 URL），保留渲染所需字段 */
function sanitizeForPublic(block: Block): Block {
  const { source: _source, ...restProps } = block.properties ?? {}
  return { ...block, properties: restProps, children: (block.children ?? []).map(sanitizeForPublic) }
}

/** token → 有效分享的行；无效一律走 404（调用方统一文案） */
function resolveShare(token: string) {
  // 粗过滤：token 定长 32 hex，避免无谓的数据库扫描与注入面
  if (!/^[0-9a-f]{32}$/.test(token)) return null
  return getShareByToken(getDb(), token)
}

/**
 * 文档 → 其引用的 asset sha 集合缓存。
 * 失效令牌 = entity_changes 的全局 MAX(seq) + 内容修订计数：任何写操作（不限
 * 于本文档）都会推进 seq 锚点；同步消费/维护清理的写路径不产 feed 行，由
 * runFeedSuppressed 递增 contentRevisionToken 兜底失效。无写时一次 MAX 查询
 * （主键索引）即可复用缓存。
 * 同步 compaction 裁剪（pruneChanges）会让锚点回退（清空后归 0）：AUTOINCREMENT
 * 不复用 seq，旧缓存条目不会被错误命中，仅裁剪后缓存于 seq=0 的条目在「再次裁剪」
 * 的极窄窗口内可能短暂沿用旧引用集合，锚点离开 0 后的首次访问即重扫自愈。
 * 不能用 doc 根的 updated_at 做失效令牌——子 block 编辑不碰根行。
 * 规模：key 仅出现在有公开分享的文档上，天然有界，无需 LRU。
 */
const docAssetRefsCache = new Map<string, { key: string; refs: string[] }>()

function getDocAssetRefs(docId: string): string[] {
  const db = getDb()
  const key = `${getChangesAnchor(db)}:${contentRevisionToken()}`
  const cached = docAssetRefsCache.get(docId)
  if (cached && cached.key === key) return cached.refs
  // 单次扫描：拼一次内容跑一遍正则，不逐块重复编译匹配
  const allContent = fetchDocBlocks(db, docId).map((r) => r.content).join('\n')
  const refs = extractAssetRefs(allContent)
  docAssetRefsCache.set(docId, { key, refs })
  return refs
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
  // 图床外链映射：已上传图床的图片，分享页直接引用图床 URL（不依赖本地/分享图片端点）
  const assetRemote: Record<string, string> = {}
  for (const id of getDocAssetRefs(share.doc_id)) {
    const url = getAssetRemoteUrl(id)
    if (url) assetRemote[id] = url
  }
  // no-store：过期/关闭语义要求每次回源，不给反代/CDN 缓存旧内容的机会
  return c.json({
    title: docRow.content,
    markdown: blocksToMarkdown(tree),
    // block 树：分享页用与登录后相同的 BlockRenderer 渲染（阅读观感对齐）
    doc: tree[0] ? sanitizeForPublic(tree[0]) : null,
    updated_at: docRow.updated_at,
    shared_at: share.created_at,
    asset_remote: assetRemote,
  }, 200, { 'Cache-Control': 'no-store' })
})

sharePublic.get('/:token/assets/:sha256', (c) => {
  const share = resolveShare(c.req.param('token'))
  if (!share) {
    return c.json({ error: 'not_found', message: '链接不存在或已关闭' }, 404)
  }

  // 引用校验：asset 必须确实被此文档引用，否则该端点会退化为全站 asset 代理
  const sha = c.req.param('sha256')
  if (!getDocAssetRefs(share.doc_id).includes(sha)) {
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
      // 内容寻址：sha 即内容哈希，永不变化，浏览器可永久缓存。
      // 但必须 private：public 会允许共享缓存（CDN / 反代）留存副本，
      // 分享关闭（token 404）后旧 URL 仍可能从缓存读到图片，无法撤回。
      // 不写 Content-Length：交由 Bun/反代（可能启 gzip）自行处理
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

export default sharePublic
