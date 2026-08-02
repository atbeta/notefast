/**
 * 数据库备份对象存储：上传快照/manifest、列举恢复点、按保留策略清理。
 *
 * 构建在 ObjectStore 抽象之上（当前为 S3 实现），后续可换 WebDAV / LocalFS。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import {
  buildManifestObjectKey,
  buildSnapshotObjectKey,
  isBackupManifest,
  normalizeBackupPrefix,
  type BackupManifest,
  type BackupRestorePoint,
  type BackupS3Config,
} from '@notefast/core'
import { createS3ObjectStore, getObjectText, type ObjectStore } from '../storage/objectStore'

export interface BackupStore {
  testConnection(): Promise<{ ok: boolean; error?: string }>
  uploadSnapshot(opts: {
    localPath: string
    sha256: string
    sizeBytes: number
    schemaVersion: number
    appVersion?: string
  }): Promise<{ objectKey: string; manifestKey: string; manifest: BackupManifest }>
  listRestorePoints(opts?: { limit?: number }): Promise<BackupRestorePoint[]>
  downloadObject(key: string, destPath: string): Promise<void>
  getManifest(manifestKey: string): Promise<BackupManifest>
  pruneOlderThan(retentionDays: number): Promise<{ deleted: number; errors: string[] }>
  /** 底层对象存储（media 上送/拉回复用同一凭据与连接） */
  objectStore: ObjectStore
}

export function createBackupStore(cfg: BackupS3Config, injected?: ObjectStore): BackupStore {
  const prefix = normalizeBackupPrefix(cfg.prefix)
  const objectStore =
    injected ??
    createS3ObjectStore({
      bucket: cfg.bucket,
      region: cfg.region,
      endpoint: cfg.endpoint,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      forcePathStyle: cfg.forcePathStyle,
    })

  return {
    objectStore,

    async testConnection() {
      return objectStore.testConnection()
    },

    async uploadSnapshot({ localPath, sha256, sizeBytes, schemaVersion, appVersion }) {
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      const objectKey = buildSnapshotObjectKey(prefix, id)
      const manifestKey = buildManifestObjectKey(objectKey)
      const body = readFileSync(localPath)
      await objectStore.putObject(objectKey, body)
      const manifest: BackupManifest = {
        app: 'notefast',
        kind: 'sqlite-snapshot',
        version: 1,
        createdAt: new Date().toISOString(),
        objectKey,
        sizeBytes,
        sha256,
        schemaVersion,
        appVersion,
      }
      await objectStore.putObject(manifestKey, JSON.stringify(manifest, null, 2))
      return { objectKey, manifestKey, manifest }
    },

    async listRestorePoints({ limit = 50 } = {}) {
      // ListObjects 按 key 字典序；快照 key 含可排序时间戳。
      // UI 只需最新 N 条：先列齐 key，再按 key 倒序取前 N 并 GET manifest。
      // prune 走 listAllManifestPoints，不受此 limit 影响。
      const keys = await listAllManifestKeys()
      keys.sort((a, b) => b.localeCompare(a))
      const selected =
        Number.isFinite(limit) && limit > 0 ? keys.slice(0, limit) : keys
      const points: BackupRestorePoint[] = []
      for (const key of selected) {
        try {
          points.push(await pointFromManifestKey(key))
        } catch {
          /* 跳过损坏 manifest */
        }
      }
      points.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return points
    },

    async downloadObject(key, destPath) {
      const bytes = await objectStore.getObject(key)
      if (!bytes) throw new Error(`空对象: ${key}`)
      writeFileSync(destPath, Buffer.from(bytes))
    },

    async getManifest(manifestKey) {
      return getManifestByKey(manifestKey)
    },

    async pruneOlderThan(retentionDays) {
      const cutoff = Date.now() - retentionDays * 86_400_000
      // 必须全量列举：若只取最新 N 条，更老的对象永远进不了候选集
      const points = await listAllManifestPoints()
      let deleted = 0
      const errors: string[] = []
      for (const p of points) {
        const t = Date.parse(p.createdAt)
        if (!Number.isFinite(t) || t >= cutoff) continue
        const res = await objectStore.deleteObjects([p.objectKey, p.manifestKey])
        deleted += res.deleted
        errors.push(...res.errors)
      }
      return { deleted, errors }
    },
  }

  async function listAllManifestKeys(): Promise<string[]> {
    const keys = await objectStore.listObjects(`${prefix}snapshots/`)
    return keys.filter((key) => key.endsWith('.manifest.json'))
  }

  async function pointFromManifestKey(key: string): Promise<BackupRestorePoint> {
    const manifest = await getManifestByKey(key)
    return {
      objectKey: manifest.objectKey,
      manifestKey: key,
      createdAt: manifest.createdAt,
      sizeBytes: manifest.sizeBytes,
      sha256: manifest.sha256,
      schemaVersion: manifest.schemaVersion,
      appVersion: manifest.appVersion,
    }
  }

  async function listAllManifestPoints(): Promise<BackupRestorePoint[]> {
    const keys = await listAllManifestKeys()
    const points: BackupRestorePoint[] = []
    for (const key of keys) {
      try {
        points.push(await pointFromManifestKey(key))
      } catch {
        /* 跳过损坏 manifest */
      }
    }
    return points
  }

  async function getManifestByKey(manifestKey: string): Promise<BackupManifest> {
    const text = await getObjectText(objectStore, manifestKey)
    if (!text) throw new Error(`空 manifest: ${manifestKey}`)
    const parsed = JSON.parse(text) as unknown
    if (!isBackupManifest(parsed)) throw new Error(`无效 manifest: ${manifestKey}`)
    return parsed
  }
}
