/**
 * S3 Sync Adapter — Markdown 单向归档
 *
 * 使用真实 AWS SDK Command；文件名含 docId；维护 notefast-archive.manifest.json。
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  blocksToMarkdown,
  buildBlockTree,
  type SyncAdapter,
  type SyncInfo,
  type SyncResult,
  type PushOptions,
  type S3AdapterConfig,
  type BlockRow,
} from '@notefast/core'
import { getDb } from '../db'
import { fetchDocBlocks } from '../dbQueries'
import {
  ARCHIVE_MANIFEST_NAME,
  archiveFilename,
  buildArchiveManifest,
  isArchiveManifest,
  staleArchiveKeys,
  type ArchiveManifest,
} from './archive'

export interface S3ClientLike {
  send(command: unknown): Promise<unknown>
}

export interface CreateS3AdapterOptions {
  client?: S3ClientLike
}

function normalizePrefix(prefix?: string): string {
  if (!prefix) return ''
  return prefix.endsWith('/') ? prefix : prefix + '/'
}

export function createS3Adapter(
  cfg: S3AdapterConfig,
  opts: CreateS3AdapterOptions = {},
): SyncAdapter {
  if (!cfg.enabled) throw new Error('S3 adapter not enabled')
  if (!cfg.bucket) throw new Error('S3 bucket 不能为空')
  if (!cfg.region) throw new Error('S3 region 不能为空')
  if (!cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error('S3 accessKeyId / secretAccessKey 必填')
  }

  const client: S3ClientLike =
    opts.client ??
    new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint || undefined,
      forcePathStyle: cfg.forcePathStyle ?? false,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    })
  const bucket = cfg.bucket
  const prefix = normalizePrefix(cfg.prefix)

  async function loadPreviousManifest(keyPrefix: string): Promise<ArchiveManifest | null> {
    const key = `${keyPrefix}${ARCHIVE_MANIFEST_NAME}`
    try {
      const res = (await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      )) as { Body?: { transformToString: () => Promise<string> } }
      const text = await res.Body?.transformToString()
      if (!text) return null
      const parsed = JSON.parse(text) as unknown
      return isArchiveManifest(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  return {
    name: 's3',

    async info(): Promise<SyncInfo> {
      try {
        const res = (await client.send(new HeadBucketCommand({ Bucket: bucket }))) as {
          BucketRegion?: string
        }
        return {
          extra: {
            bucket,
            region: cfg.region,
            endpoint: cfg.endpoint || '(default AWS)',
            prefix,
            forcePathStyle: cfg.forcePathStyle ?? false,
            ok: true,
            status: res.BucketRegion ?? cfg.region,
          },
        }
      } catch (e) {
        return {
          extra: {
            bucket,
            region: cfg.region,
            endpoint: cfg.endpoint || '(default AWS)',
            prefix,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          },
        }
      }
    },

    async push(options?: PushOptions): Promise<SyncResult> {
      const db = getDb()
      const docIds = options?.docIds
      const keyPrefix = normalizePrefix(options?.prefix ?? cfg.prefix)

      let sql = "SELECT * FROM blocks WHERE type = 'document'"
      const params: string[] = []
      if (docIds && docIds.length > 0) {
        sql += ` AND id IN (${docIds.map(() => '?').join(',')})`
        params.push(...docIds)
      }
      sql += ' ORDER BY updated_at ASC'
      const docs = db.query(sql).all(...params) as BlockRow[]

      const result: SyncResult = { pushed: 0, pulled: 0, errors: [] }
      const files: ArchiveManifest['files'] = []
      const previous = await loadPreviousManifest(keyPrefix)

      for (const doc of docs) {
        try {
          const tree = buildBlockTree(fetchDocBlocks(db, doc.id))
          const markdown = blocksToMarkdown(tree)
          const filename = archiveFilename(doc.content || 'untitled', doc.id)
          const key = `${keyPrefix}${filename}`
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: markdown,
              ContentType: 'text/markdown; charset=utf-8',
            }),
          )
          files.push({
            docId: doc.id,
            title: doc.content || 'untitled',
            filename,
            key,
          })
          result.pushed++
        } catch (e) {
          result.errors.push(`${doc.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // 全量推送时才清理陈旧文件（按文档过滤时不删）
      if (!docIds || docIds.length === 0) {
        const manifest = buildArchiveManifest({ adapter: 's3', files })
        const stale = staleArchiveKeys(previous, manifest)
        for (const key of stale) {
          try {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
          } catch (e) {
            result.errors.push(`delete ${key}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: `${keyPrefix}${ARCHIVE_MANIFEST_NAME}`,
              Body: JSON.stringify(manifest, null, 2),
              ContentType: 'application/json; charset=utf-8',
            }),
          )
        } catch (e) {
          result.errors.push(`manifest: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      return result
    },
  }
}
