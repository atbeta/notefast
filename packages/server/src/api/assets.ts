/**
 * Assets API
 *
 * - POST   /api/v1/assets            上传图片（body = 原始字节，Content-Type = 图片 mime）→ { id, url, dedup }
 * - GET    /api/v1/assets/:id        读取图片（Bearer/Basic 或会话 cookie；内容寻址，强缓存）
 * - POST   /api/v1/assets/gc         孤儿回收（无引用且超过宽限期的 asset 删除）
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { readFileSync } from 'node:fs'
import {
  collectOrphanAssets,
  findMissingAssets,
  getAssetRemoteUrl,
  MAX_ASSET_BYTES,
  maybeUploadToRemote,
  readAsset,
  saveAsset,
} from '../assets/store'
import { imageUploadConfigSchema, type ImageUploadConfigInput } from '@notefast/core'
import {
  applyImageUploadConfig,
  getImageUploadPublicConfig,
} from '../services/imageUploadConfig'

const assets = new Hono()

assets.post('/', async (c) => {
  const mime = (c.req.header('Content-Type') || '').split(';')[0].trim().toLowerCase()
  if (!mime.startsWith('image/')) {
    return c.json({ error: 'bad_request', message: `仅接受图片（image/*），收到 ${mime || '未知类型'}` }, 400)
  }
  const buf = Buffer.from(await c.req.arrayBuffer())
  if (buf.length === 0) {
    return c.json({ error: 'bad_request', message: '空内容' }, 400)
  }
  if (buf.length > MAX_ASSET_BYTES) {
    return c.json({ error: 'too_large', message: `图片超过 ${MAX_ASSET_BYTES / 1024 / 1024}MB 上限` }, 413)
  }
  const { meta, dedup } = saveAsset(buf, mime)
  // 自动上传模式：异步旁路传图床（不阻塞响应；失败静默降级本地）
  maybeUploadToRemote(meta.id)
  return c.json(
    {
      id: meta.id,
      url: `/api/v1/assets/${meta.id}`,
      ref: `asset:${meta.id}`,
      mime: meta.mime,
      size: meta.size,
      dedup,
    },
    dedup ? 200 : 201,
  )
})

/** 图床上传配置：读取（无密钥，原样返回）——必须在 /:id 之前注册，否则被当作 asset id */
assets.get('/upload-config', (c) => {
  return c.json(getImageUploadPublicConfig())
})

/** 图床上传配置：保存（mode=off|auto + 命令 + 参数 + 超时） */
assets.put('/upload-config', zValidator('json', imageUploadConfigSchema), async (c) => {
  const body = c.req.valid('json') as ImageUploadConfigInput
  const next = applyImageUploadConfig(body)
  return c.json(next)
})

assets.get('/:id', (c) => {
  const id = c.req.param('id')
  // 图床模式：已外链的 asset 直接 302 到图床（内网直连，不经本地代理）
  const remoteUrl = getAssetRemoteUrl(id)
  if (remoteUrl) {
    return c.redirect(remoteUrl, 302)
  }
  const found = readAsset(id)
  if (!found) {
    return c.json({ error: 'not_found', message: '图片不存在' }, 404)
  }
  const bytes = readFileSync(found.path)
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': found.meta.mime,
      'Content-Length': String(found.meta.size),
      // 内容寻址：id 即内容哈希，永不变化，可永久缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

assets.post('/gc', (c) => {
  const result = collectOrphanAssets()
  return c.json(result)
})

/** 对账辅助：校验一组 asset id 是否存在（编辑器/导入路径用，告警不阻断） */
assets.post('/check', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { ids?: unknown }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : []
  return c.json({ missing: findMissingAssets(ids.slice(0, 500)) })
})

export default assets
