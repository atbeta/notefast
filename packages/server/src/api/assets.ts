/**
 * Assets API
 *
 * - POST   /api/v1/assets            上传图片（body = 原始字节，Content-Type = 图片 mime）→ { id, url, dedup }
 * - GET    /api/v1/assets/:id        读取图片（Bearer/Basic 或会话 cookie；内容寻址，强缓存）
 * - POST   /api/v1/assets/gc         孤儿回收（无引用且超过宽限期的 asset 删除）
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  collectOrphanAssets,
  findMissingAssets,
  getUploadBatchStatus,
  MAX_ASSET_BYTES,
  maybeUploadToRemote,
  readAsset,
  runUploadCommand,
  saveAsset,
  uploadMissingAssets,
} from '../assets/store'
import { imageUploadConfigSchema, type ImageUploadConfigInput } from '@notefast/core'
import {
  applyImageUploadConfig,
  getImageUploadPublicConfig,
  getImageUploadConfig,
} from '../services/imageUploadConfig'
import { getDb } from '../db'

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
  const cfg = getImageUploadPublicConfig()
  // 「最近一次上传失败」按最近上传尝试判定：取 upload_attempted_at 最新的一行，
  // 仅当那次尝试失败才返回（最近一次成功 → 不再显示历史失败）
  const lastTry = getDb().query(
    'SELECT upload_error, upload_attempted_at FROM assets WHERE upload_attempted_at IS NOT NULL ORDER BY upload_attempted_at DESC LIMIT 1',
  ).get() as { upload_error: string | null; upload_attempted_at: string } | undefined
  const lastError = lastTry?.upload_error
    ? { at: lastTry.upload_attempted_at, message: lastTry.upload_error }
    : null
  return c.json({ ...cfg, last_error: lastError })
})

/** 图床上传配置：保存（mode=off|auto + 命令 + 参数 + 超时） */
assets.put('/upload-config', zValidator('json', imageUploadConfigSchema), async (c) => {
  const body = c.req.valid('json') as ImageUploadConfigInput
  const next = applyImageUploadConfig(body)
  return c.json(next)
})

/**
 * 测试图床命令：用 1×1 PNG 跑一次命令，返回完整诊断（stdout/stderr/exit code）。
 * 解决「静默降级看不见报错」：用户保存配置后先点测试，立即知道命令能不能跑。
 */
assets.post('/upload-config/test', async (c) => {
  const cfg = getImageUploadConfig()
  if (cfg.mode !== 'auto' || !cfg.command.trim()) {
    return c.json({ ok: false, error: '未启用自动上传或命令为空' }, 400)
  }
  // 1×1 红色 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const tmpFile = join(tmpdir(), `notefast-upload-test-${randomUUID()}.png`)
  writeFileSync(tmpFile, png)
  try {
    const outcome = await runUploadCommand(cfg, tmpFile)
    return c.json({
      ok: outcome.ok,
      url: outcome.url ?? null,
      error: outcome.error ?? null,
      stdout: (outcome.stdout ?? '').slice(0, 2000),
      stderr: (outcome.stderr ?? '').slice(0, 2000),
      exit_code: outcome.exitCode,
    })
  } finally {
    try { unlinkSync(tmpFile) } catch { /* ignore */ }
  }
})

/**
 * 存量图片补传：remote_url IS NULL 的全部 assets 串行上传（后台队列）。
 * 未启用自动上传 → 400；已在跑 → 返回 running。
 */
assets.post('/upload-missing', async (c) => {
  const cfg = getImageUploadConfig()
  if (cfg.mode !== 'auto' || !cfg.command.trim()) {
    return c.json({ error: 'bad_request', message: '未启用自动上传或命令为空' }, 400)
  }
  return c.json(uploadMissingAssets())
})

/** 存量补传进度（内存态）——必须在 /:id 之前注册，否则被当作 asset id */
assets.get('/upload-status', (c) => {
  return c.json(getUploadBatchStatus())
})

assets.get('/:id', (c) => {
  const id = c.req.param('id')
  // 显示永远走本地读：remote_url 不参与渲染（302 到图床会踩防盗链/跨域/可达性），
  // 只作为导出外链替换的元数据（asset:<id> 引用语义与本地优先设计不变）
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
