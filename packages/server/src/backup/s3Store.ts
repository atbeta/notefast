/**
 * S3 备份对象存储：上传快照/manifest、列举恢复点、按保留策略清理
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
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

export interface S3StoreLike {
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
  /** 底层 S3Client（media 内容寻址上送复用同一凭据与连接；mock store 可省略以跳过 media） */
  mediaClient?: S3Client
}

export function createS3Store(cfg: BackupS3Config, client?: S3Client): S3StoreLike {
  const prefix = normalizeBackupPrefix(cfg.prefix)
  const s3 =
    client ??
    new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint || undefined,
      forcePathStyle: cfg.forcePathStyle ?? false,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    } satisfies S3ClientConfig)

  return {
    mediaClient: s3,

    async testConnection() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: cfg.bucket }))
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },

    async uploadSnapshot({ localPath, sha256, sizeBytes, schemaVersion, appVersion }) {
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      const objectKey = buildSnapshotObjectKey(prefix, id)
      const manifestKey = buildManifestObjectKey(objectKey)
      const body = readFileSync(localPath)
      await s3.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: objectKey,
          Body: body,
          ContentType: 'application/x-sqlite3',
          Metadata: {
            sha256,
            schemaversion: String(schemaVersion),
          },
        }),
      )
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
      await s3.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: manifestKey,
          Body: JSON.stringify(manifest, null, 2),
          ContentType: 'application/json; charset=utf-8',
        }),
      )
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
      const res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }))
      const bytes = await res.Body?.transformToByteArray()
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
        for (const key of [p.objectKey, p.manifestKey]) {
          try {
            await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }))
            deleted++
          } catch (e) {
            errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
      return { deleted, errors }
    },
  }

  async function listAllManifestKeys(): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined
    const listPrefix = `${prefix}snapshots/`
    do {
      const res = await s3.send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: listPrefix,
          ContinuationToken: token,
        }),
      )
      for (const obj of res.Contents ?? []) {
        const key = obj.Key
        if (key && key.endsWith('.manifest.json')) keys.push(key)
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token)
    return keys
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
    const res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: manifestKey }))
    const text = await res.Body?.transformToString()
    if (!text) throw new Error(`空 manifest: ${manifestKey}`)
    const parsed = JSON.parse(text) as unknown
    if (!isBackupManifest(parsed)) throw new Error(`无效 manifest: ${manifestKey}`)
    return parsed
  }
}
