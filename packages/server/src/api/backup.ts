/**
 * Backup API
 *
 * - GET    /api/v1/backup/config
 * - PUT    /api/v1/backup/config
 * - DELETE /api/v1/backup/config
 * - GET    /api/v1/backup/status
 * - POST   /api/v1/backup/test
 * - POST   /api/v1/backup/run
 * - GET    /api/v1/backup/restore-points
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { backupConfigSchema, type BackupConfigInput } from '@notefast/core'
import {
  applyBackupManagerConfig,
  backupStatus,
  disableBackupManager,
  getBackupPublicConfig,
  isBackupConfigured,
  listBackupRestorePoints,
  runBackupNow,
  testBackupConnection,
} from '../backup/manager'

const backup = new Hono()

backup.get('/config', (c) => {
  return c.json({
    configured: isBackupConfigured(),
    config: getBackupPublicConfig(),
    status: backupStatus(),
  })
})

backup.put('/config', zValidator('json', backupConfigSchema), async (c) => {
  const body = c.req.valid('json')
  const next: BackupConfigInput = {
    version: 1,
    enabled: body.enabled,
    s3: body.s3,
    // 备份仅支持手动：不调度自动全量备份
    intervalMs: 0,
    retentionDays: body.retentionDays ?? 30,
  }
  if (next.enabled && !next.s3) {
    return c.json({ error: 'bad_request', message: '启用备份时必须提供 s3 配置' }, 400)
  }
  const status = await applyBackupManagerConfig(next)
  return c.json({ ok: true, status, config: getBackupPublicConfig() })
})

backup.delete('/config', async (c) => {
  const status = await disableBackupManager()
  return c.json({ ok: true, status })
})

backup.get('/status', (c) => c.json(backupStatus()))

backup.post('/test', async (c) => {
  if (!isBackupConfigured()) {
    return c.json({ error: 'not_configured', message: '备份未配置' }, 400)
  }
  const result = await testBackupConnection()
  return c.json(result, result.ok ? 200 : 502)
})

backup.post('/run', async (c) => {
  try {
    const result = await runBackupNow()
    return c.json({ ok: true, result, status: backupStatus() })
  } catch (e) {
    const code = (e as { code?: string }).code
    const message = e instanceof Error ? e.message : String(e)
    if (code === 'backup_in_progress') {
      return c.json({ error: 'backup_in_progress', message }, 409)
    }
    if (code === 'not_configured') {
      return c.json({ error: 'not_configured', message }, 400)
    }
    return c.json({ error: 'backup_failed', message }, 500)
  }
})

backup.get('/restore-points', async (c) => {
  if (!isBackupConfigured()) {
    return c.json({ error: 'not_configured', message: '备份未配置' }, 400)
  }
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50))
  try {
    const points = await listBackupRestorePoints(limit)
    return c.json({ points })
  } catch (e) {
    return c.json(
      { error: 'list_failed', message: e instanceof Error ? e.message : String(e) },
      500,
    )
  }
})

export default backup
