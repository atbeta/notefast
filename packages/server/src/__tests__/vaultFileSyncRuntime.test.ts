/**
 * vault 文件同步运行时 + API（RFC 0004 P2）
 *
 * 单实例运行时 + 一个「远端设备」（P1 引擎）经同一个 LocalFS 目标交互，
 * 覆盖：配置解析、push/pull 状态、落盘后索引跟随、协议同步短路。
 */

import { Database } from 'bun:sqlite'
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import { createStorageLocation, initStorageLocations } from '../storage/locations'
import { initProtocolManager, setProtocolSyncSuppressed, syncNow } from '../sync/protocolManager'
import { createLocalFsObjectStore } from '../storage/webdavStore'
import { DEFAULT_VAULT_IGNORE, type VaultConfig } from '../vault/config'
import { createVaultRouter, createVaultRuntime, type VaultRuntime } from '../vault'
import { detectForeignSyncHints, resolveVaultSyncTarget } from '../vault/fileSyncRuntime'
import { disableVaultFileSyncConfig, initVaultFileSyncConfig } from '../vault/fileSyncConfig'
import { ensureVaultSyncMeta, pushVaultFiles, type FileSyncDeps } from '../vault/fileSync'
import * as m027 from '../migrations/027_vault_sync_state'

let dataDir: string
let vaultDir: string
let remoteDir: string
let storeDir: string
let notebookId: string
let runtime: VaultRuntime
let remoteDb: Database

const PREFIX = 'vault-sync/'

function makeConfig(root: string): VaultConfig {
  return {
    root,
    ignore: [...DEFAULT_VAULT_IGNORE],
    watch: false,
    writeback: true,
    stabilityMs: 50,
    usePolling: true,
    pollIntervalMs: 50,
    reconcileMinutes: 0,
  }
}

/** 模拟「另一台设备」：独立 DB + 独立 vault 目录，推进同一个 store */
async function remotePush(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(remoteDir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  const deps: FileSyncDeps = {
    store: createLocalFsObjectStore(storeDir),
    prefix: PREFIX,
    root: remoteDir,
    ignore: [...DEFAULT_VAULT_IGNORE],
    deviceId: 'remote-device',
    db: remoteDb,
  }
  await ensureVaultSyncMeta(deps.store, PREFIX, null)
  await pushVaultFiles(deps)
}

beforeAll(() => {
  dataDir = mkdtempSync(join('/tmp', 'nf-fsync-data-'))
  vaultDir = mkdtempSync(join('/tmp', 'nf-fsync-vault-'))
  remoteDir = mkdtempSync(join('/tmp', 'nf-fsync-remote-'))
  storeDir = mkdtempSync(join('/tmp', 'nf-fsync-store-'))
  notebookId = initDb(dataDir).notebookId
  initStorageLocations(dataDir)
  initProtocolManager(dataDir)
  initVaultFileSyncConfig(dataDir)
})

afterAll(async () => {
  if (runtime) await runtime.stop().catch(() => undefined)
  remoteDb?.close()
  closeDb()
  for (const dir of [dataDir, vaultDir, remoteDir, storeDir]) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  setProtocolSyncSuppressed(null)
  // 配置落在 dataDir 的 JSON 文件里，逐个用例清空，避免相互影响
  initVaultFileSyncConfig(dataDir)
  disableVaultFileSyncConfig()
  remoteDb?.close()
  remoteDb = new Database(':memory:')
  m027.up(remoteDb)
})

describe('vault 文件同步运行时', () => {
  test('未配置：enabled=false、configured=false，状态可读', async () => {
    runtime = createVaultRuntime({ db: getDb(), notebookId, config: makeConfig(vaultDir) })
    await runtime.start({ awaitReconcile: true })
    try {
      const status = runtime.sync.status()
      expect(status.enabled).toBe(false)
      expect(status.configured).toBe(false)
      expect(status.target).toBeNull()
      expect(status.device_id).toBeTruthy()
      expect(status.tracked_files).toBe(0)
    } finally {
      await runtime.stop()
      getDb().query(`UPDATE notebooks SET kind = 'db', vault_root = NULL WHERE id = ?`).run(notebookId)
    }
  })

  test('配置 LocalFS 目标 → 推送到远端；远端新增 → pull 落盘且索引跟随', async () => {
    runtime = createVaultRuntime({ db: getDb(), notebookId, config: makeConfig(vaultDir) })
    await runtime.start({ awaitReconcile: true })
    try {
      const status = runtime.sync.applyConfig({
        enabled: true,
        locationId: null,
        localDir: storeDir,
        prefix: PREFIX,
        intervalSeconds: 0,
      })
      expect(status.configured).toBe(true)
      expect(status.target).toBe(`local:${storeDir}`)

      // 本端文件 → push（首推生成 vault 身份）
      writeFileSync(join(vaultDir, 'local.md'), '本地内容\n', 'utf8')
      const pushed = await runtime.sync.push()
      expect(pushed.changed).toBeGreaterThanOrEqual(1)
      const afterPush = runtime.sync.status()
      expect(afterPush.last_push_at).toBeTruthy()
      expect(afterPush.vault_id).toBeTruthy()

      // 远端设备写入 → pull
      await remotePush({ 'from-remote.md': '远端内容\n' })
      const pulled = await runtime.sync.pull()
      expect(pulled.applied).toBeGreaterThanOrEqual(1)
      expect(readFileSync(join(vaultDir, 'from-remote.md'), 'utf8')).toBe('远端内容\n')
      // 落盘后索引跟随（light reconcile 兜底）
      expect(runtime.status().files).toBeGreaterThanOrEqual(2)
    } finally {
      await runtime.stop()
      getDb().query(`UPDATE notebooks SET kind = 'db', vault_root = NULL WHERE id = ?`).run(notebookId)
    }
  })

  test('HTTP：/sync/status、/sync/config、/sync/push、/sync/pull', async () => {
    runtime = createVaultRuntime({ db: getDb(), notebookId, config: makeConfig(vaultDir) })
    await runtime.start({ awaitReconcile: true })
    const app = new Hono()
    app.route('/api/v1/vault', createVaultRouter(() => runtime))
    try {
      const initial = (await (await app.request('/api/v1/vault/sync/status')).json()) as {
        configured: boolean
      }
      expect(initial.configured).toBe(false)

      const put = await app.request('/api/v1/vault/sync/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, locationId: null, localDir: storeDir, prefix: PREFIX, intervalSeconds: 0 }),
      })
      expect(put.status).toBe(200)
      expect(((await put.json()) as { configured: boolean }).configured).toBe(true)

      // 配置读接口（表单回填用，不含凭据）
      const cfg = (await (await app.request('/api/v1/vault/sync/config')).json()) as {
        enabled: boolean
        localDir: string
        prefix: string
      }
      expect(cfg.enabled).toBe(true)
      expect(cfg.localDir).toBe(storeDir)
      expect(cfg.prefix).toBe(PREFIX)

      expect((await app.request('/api/v1/vault/sync/push', { method: 'POST' })).status).toBe(200)
      expect((await app.request('/api/v1/vault/sync/pull', { method: 'POST' })).status).toBe(200)
      // 空闲时 in_flight=false
      const st = (await (await app.request('/api/v1/vault/sync/status')).json()) as { in_flight: boolean }
      expect(st.in_flight).toBe(false)

      // 目标不可用 → 400 且状态里带原因
      const bad = await app.request('/api/v1/vault/sync/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, locationId: 'nope', intervalSeconds: 0 }),
      })
      expect(bad.status).toBe(400)
    } finally {
      await runtime.stop()
      getDb().query(`UPDATE notebooks SET kind = 'db', vault_root = NULL WHERE id = ?`).run(notebookId)
    }
  })

  test('第三方同步痕迹检测：iCloud / Dropbox / Syncthing / sync-conflict', () => {
    const dir = mkdtempSync(join('/tmp', 'nf-foreign-'))
    try {
      mkdirSync(join(dir, '.icloud'), { recursive: true })
      writeFileSync(join(dir, '.dropbox'), '')
      mkdirSync(join(dir, '.stfolder'), { recursive: true })
      writeFileSync(join(dir, 'note.sync-conflict-20260910-120000-ABCDEFG.md'), 'x')
      expect(detectForeignSyncHints(dir).sort()).toEqual(['Dropbox', 'Syncthing', 'iCloud', 'sync-conflict'])
      expect(detectForeignSyncHints(mkdtempSync(join('/tmp', 'nf-clean-')))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('目标解析：localDir 优先、缺连接报错、S3 连接可构造 store', () => {
    const base = { version: 1 as const, enabled: true, locationId: null, localDir: '', prefix: 'p/', intervalSeconds: 0, vaultId: null }
    const local = resolveVaultSyncTarget({ ...base, localDir: storeDir })
    expect('target' in local && local.target).toBe(`local:${storeDir}`)
    expect(resolveVaultSyncTarget({ ...base, locationId: 'nope' })).toMatchObject({ error: expect.stringContaining('不存在') })

    // createStorageLocation 自己生成 id（入参 id 被忽略）
    const created = createStorageLocation({
      id: '',
      name: 'sync test',
      kind: 's3',
      s3: { bucket: 'bkt', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' },
    })
    const s3 = resolveVaultSyncTarget({ ...base, locationId: created.id })
    expect('target' in s3 && s3.target).toBe('s3://bkt/p/')
  })

  test('vault 模式停用协议同步：syncNow 抛专用错误码', async () => {
    setProtocolSyncSuppressed('vault notebook 使用文件同步')
    await expect(syncNow()).rejects.toMatchObject({ code: 'vault_mode_uses_file_sync' })
    setProtocolSyncSuppressed(null)
  })
})
