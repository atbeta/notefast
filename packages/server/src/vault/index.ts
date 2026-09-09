/**
 * vault mode 入口 — 文件作为权威、SQLite 作为派生索引
 *
 * @see docs/rfcs/0001-vault-mode.md
 * @see docs/rfcs/0002-block-identity.md
 */

import type { Hono } from 'hono'
import { logger } from '../logger'
import { loadVaultConfig, type VaultConfig } from './config'
import { startVaultWatcher, stopVaultWatcher, type VaultWatcher } from './watcher'
import { ingestFile, rebuildVaultIndex, type IngestStats } from './ingest'

export interface VaultRuntime {
  config: VaultConfig
  watcher: VaultWatcher | null
  start: () => Promise<void>
  stop: () => Promise<void>
  ingest: (filePath: string) => Promise<IngestStats>
  rebuild: () => Promise<{ totalFiles: number; totalBlocks: number; durationMs: number }>
}

export async function createVaultRuntime(): Promise<VaultRuntime | null> {
  const config = await loadVaultConfig()
  if (!config) {
    logger.info('vault mode not configured; skipping runtime init')
    return null
  }

  let watcher: VaultWatcher | null = null

  return {
    config,
    get watcher() {
      return watcher
    },
    async start() {
      logger.info(`vault: starting watcher at ${config.path}`)
      watcher = await startVaultWatcher(config, {
        onChange: async (filePath) => {
          const stats = await ingestFile(filePath, config)
          logger.debug(`vault: ingest ${filePath} (${stats.kept} kept, ${stats.inserted} inserted, ${stats.updated} updated, ${stats.deleted} deleted)`)
        },
        onDelete: async (filePath) => {
          logger.info(`vault: file deleted: ${filePath}`)
          // TODO: mark doc as stale (do NOT delete yet; 30-day recovery window)
        },
      })
    },
    async stop() {
      if (watcher) {
        await stopVaultWatcher(watcher)
        watcher = null
      }
    },
    async ingest(filePath) {
      return ingestFile(filePath, config)
    },
    async rebuild() {
      return rebuildVaultIndex(config)
    },
  }
}

/** 注册 vault mode 路由到 Hono 应用 */
export function registerVaultRoutes(app: Hono, runtime: VaultRuntime): void {
  app.get('/api/v1/vault/status', (c) =>
    c.json({
      enabled: true,
      path: runtime.config.path,
      watcherActive: runtime.watcher !== null,
    }),
  )

  app.post('/api/v1/vault/rebuild', async (c) => {
    const result = await runtime.rebuild()
    return c.json(result)
  })

  app.post('/api/v1/vault/ingest', async (c) => {
    const { filePath } = await c.req.json<{ filePath: string }>()
    if (!filePath) return c.json({ error: 'filePath required' }, 400)
    const stats = await runtime.ingest(filePath)
    return c.json(stats)
  })
}
