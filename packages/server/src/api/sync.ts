/**
 * Sync API
 *
 * 路由：
 * - GET    /api/v1/sync/config   当前同步配置（脱敏）
 * - PUT    /api/v1/sync/config   更新配置 + 热切换
 * - DELETE /api/v1/sync/config   禁用同步
 * - GET    /api/v1/sync/status   runtime 状态（lastRunAt / lastError 等）
 * - GET    /api/v1/sync/info     探测远端（adapter.info()）
 * - POST   /api/v1/sync/run      手动触发 push
 *
 * /export/markdown 仍保留（向后兼容老接口）
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db'
import {
  blocksToMarkdown,
  buildBlockTree,
  type SyncPersistedConfig,
  type SyncAdapterConfig,
} from '@notefast/core'
import type { BlockRow } from '@notefast/core'
import {
  applySyncConfig,
  getSyncPublicConfig,
  isSyncConfigured,
  loadConfigFromDisk,
  saveConfigToDisk,
  syncInfo,
  syncPush,
  syncStatus,
} from '../sync/manager'

const sync = new Hono()

const localFsSchema = z.object({
  kind: z.literal('localfs'),
  dir: z.string().min(1),
  prefix: z.string().optional(),
  enabled: z.boolean(),
})

const s3Schema = z.object({
  kind: z.literal('s3'),
  bucket: z.string().min(1),
  region: z.string().min(1),
  endpoint: z.string().optional(),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  prefix: z.string().optional(),
  forcePathStyle: z.boolean().optional(),
  enabled: z.boolean(),
})

const configSchema = z.object({
  active: z.union([localFsSchema, s3Schema]).nullable(),
  autoSyncIntervalMs: z.number().int().min(0).max(86_400_000).optional(),
})

// ───────────────────── 兼容旧版：一次性导出 ─────────────────────

sync.get('/export/markdown', (c) => {
  if (!isSyncConfigured()) {
    const dir = process.env.AUTO_EXPORT_DIR
    if (!dir) {
      return c.json({ error: 'not_configured', message: '未配置 AUTO_EXPORT_DIR 环境变量' }, 400)
    }
    return c.json(legacyExportMarkdown(dir), 200)
  }
  // 已经有 sync adapter 配置了；优先用 sync 路径
  return c.json({ error: 'overridden', message: '请使用 POST /api/v1/sync/run' }, 400)
})

function legacyExportMarkdown(dir: string) {
  const db = getDb()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const docs = db.query("SELECT * FROM blocks WHERE type = 'document' ORDER BY updated_at ASC").all() as BlockRow[]
  const results: { id: string; title: string; file: string; error?: string }[] = []
  for (const doc of docs) {
    try {
      const rows = fetchDescendants(db, doc.id)
      const tree = buildBlockTree([doc, ...rows])
      const markdown = blocksToMarkdown(tree)
      const slug = sanitizeFilename(doc.content || 'untitled')
      const filename = `${slug}.md`
      writeFileSync(join(dir, filename), markdown, 'utf-8')
      results.push({ id: doc.id, title: doc.content, file: filename })
    } catch (e) {
      results.push({ id: doc.id, title: doc.content, file: '', error: String(e) })
    }
  }
  return { exported: results.length, files: results, dir }
}

// ───────────────────── 标准路由 ─────────────────────

sync.get('/config', (c) => {
  return c.json({
    configured: isSyncConfigured(),
    config: getSyncPublicConfig(),
    status: syncStatus(),
  })
})

sync.put('/config', zValidator('json', configSchema), async (c) => {
  const body = c.req.valid('json')
  const active = body.active as SyncAdapterConfig | null
  const next: SyncPersistedConfig = {
    version: 1,
    active,
    autoSyncIntervalMs: body.autoSyncIntervalMs,
  }
  const status = await applySyncConfig(next)
  return c.json({ ok: true, status })
})

sync.delete('/config', async (c) => {
  const next: SyncPersistedConfig = {
    version: 1,
    active: null,
    autoSyncIntervalMs: 0,
  }
  const status = await applySyncConfig(next)
  return c.json({ ok: true, status })
})

sync.get('/status', (c) => c.json(syncStatus()))

sync.get('/info', async (c) => {
  if (!isSyncConfigured()) {
    return c.json({ error: 'not_configured', message: 'Sync adapter 未配置' }, 400)
  }
  try {
    const info = await syncInfo()
    return c.json(info)
  } catch (e) {
    return c.json({ error: 'info_failed', message: e instanceof Error ? e.message : String(e) }, 500)
  }
})

const runSchema = z.object({
  docIds: z.array(z.string()).optional(),
  prefix: z.string().optional(),
})

sync.post('/run', zValidator('json', runSchema), async (c) => {
  if (!isSyncConfigured()) {
    return c.json({ error: 'not_configured', message: 'Sync adapter 未配置，请先 PUT /api/v1/sync/config' }, 400)
  }
  const body = c.req.valid('json')
  try {
    const result = await syncPush({
      docIds: body.docIds,
      prefix: body.prefix,
    })
    return c.json({ ok: true, result, status: syncStatus() })
  } catch (e) {
    return c.json({ error: 'push_failed', message: e instanceof Error ? e.message : String(e) }, 500)
  }
})

sync.post('/run-now', async (c) => {
  if (!isSyncConfigured()) {
    return c.json({ error: 'not_configured', message: 'Sync adapter 未配置' }, 400)
  }
  try {
    const result = await syncPush()
    return c.json({ ok: true, result, status: syncStatus() })
  } catch (e) {
    return c.json({ error: 'push_failed', message: e instanceof Error ? e.message : String(e) }, 500)
  }
})

/** 列出支持的 adapter 类型（前端表单下拉用） */
sync.get('/adapters', (c) => {
  return c.json({
    adapters: [
      {
        kind: 'localfs',
        label: '本地文件系统',
        fields: [
          { name: 'dir', label: '目录', type: 'path', required: true },
          { name: 'prefix', label: '文件名前缀', type: 'string', required: false },
        ],
        status: 'available',
      },
      {
        kind: 's3',
        label: 'S3 兼容对象存储',
        fields: [
          { name: 'bucket', label: 'Bucket', type: 'string', required: true },
          { name: 'region', label: 'Region', type: 'string', required: true },
          { name: 'endpoint', label: 'Endpoint (可选)', type: 'string', required: false },
          { name: 'accessKeyId', label: 'Access Key ID', type: 'string', required: true },
          { name: 'secretAccessKey', label: 'Secret Access Key', type: 'string', required: true, secret: true },
          { name: 'prefix', label: 'Key 前缀', type: 'string', required: false },
          { name: 'forcePathStyle', label: 'Path-style (MinIO)', type: 'boolean', required: false },
        ],
        status: 'available',
      },
    ],
  })
})

// ───────────────────── helpers ─────────────────────

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

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'untitled'
}

export { loadConfigFromDisk, saveConfigToDisk }
export default sync
