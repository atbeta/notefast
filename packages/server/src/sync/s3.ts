/**
 * S3 Sync Adapter — Markdown 单向归档
 *
 * 使用真实 AWS SDK Command；文件名含 docId；维护 notefast-archive.manifest.json。
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  type SyncAdapter,
  type SyncInfo,
  type SyncResult,
  type PushOptions,
  type S3LocationConfig,
} from '@notefast/core'
import { getDb } from '../db'
import { listDocRows } from '../store/blocks'
import { portableDocMarkdown } from '../services/portableMarkdown'
import { readAssetBytes } from '../assets/store'
import {
  ARCHIVE_MANIFEST_NAME,
  archiveFilename,
  buildArchiveManifest,
  isArchiveManifest,
  staleArchiveKeys,
  staleArchiveMedia,
  type ArchiveManifest,
} from './archive'
import { collectArchiveMediaRefs, rewriteAssetRefs } from './archiveMedia'

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
  s3: S3LocationConfig,
  prefix: string,
  enabled: boolean,
  opts: CreateS3AdapterOptions = {},
): SyncAdapter {
  if (!enabled) throw new Error('S3 adapter not enabled')
  if (!s3.bucket) throw new Error('S3 bucket 不能为空')
  if (!s3.region) throw new Error('S3 region 不能为空')
  if (!s3.accessKeyId || !s3.secretAccessKey) {
    throw new Error('S3 accessKeyId / secretAccessKey 必填')
  }

  const client: S3ClientLike =
    opts.client ??
    new S3Client({
      region: s3.region,
      endpoint: s3.endpoint || undefined,
      forcePathStyle: s3.forcePathStyle ?? false,
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
    })
  const bucket = s3.bucket
  const normalizedPrefix = normalizePrefix(prefix)

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
            region: s3.region,
            endpoint: s3.endpoint || '(default AWS)',
            prefix: normalizedPrefix,
            forcePathStyle: s3.forcePathStyle ?? false,
            ok: true,
            status: res.BucketRegion ?? s3.region,
          },
        }
      } catch (e) {
        return {
          extra: {
            bucket,
            region: s3.region,
            endpoint: s3.endpoint || '(default AWS)',
            prefix: normalizedPrefix,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          },
        }
      }
    },

    async push(options?: PushOptions): Promise<SyncResult> {
      const db = getDb()
      const docIds = options?.docIds
      const keyPrefix = normalizePrefix(options?.prefix ?? normalizedPrefix)

      // 归档镜像活库：软删除文档不导出（下次全量同步时经 manifest 清理远端陈旧文件）
      const docs = listDocRows(db, { docIds, order: 'updated_asc' })

      const result: SyncResult = { pushed: 0, pulled: 0, errors: [] }
      const files: ArchiveManifest['files'] = []
      const previous = await loadPreviousManifest(keyPrefix)

      // 第一遍：构建每篇 markdown + 收集 media 引用（多文档共享内容寻址，去重）
      const pending: Array<{ docId: string; key: string; filename: string; title: string; markdown: string }> = []
      const mediaRefs = new Map<string, string>() // sha → relativeKey（media/<sha><ext>）
      for (const doc of docs) {
        try {
          const markdown = portableDocMarkdown(doc)
          for (const [sha, rel] of collectArchiveMediaRefs(markdown)) mediaRefs.set(sha, rel)
          const filename = archiveFilename(doc.content || 'untitled', doc.id)
          pending.push({ docId: doc.id, key: `${keyPrefix}${filename}`, filename, title: doc.content || 'untitled', markdown })
        } catch (e) {
          result.errors.push(`${doc.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // 上送缺失的 media（内容寻址，仅补差）
      if (mediaRefs.size > 0) {
        try {
          const existing = new Set(await listObjects(client, bucket, `${keyPrefix}media/`))
          for (const [sha, rel] of mediaRefs) {
            const key = `${keyPrefix}${rel}`
            if (existing.has(key)) continue
            const bytes = readAssetBytes(sha)
            if (!bytes) continue
            await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes }))
          }
        } catch (e) {
          result.errors.push(`media: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // 重写 asset: 引用为相对路径后上传文档
      for (const p of pending) {
        try {
          const markdown = rewriteAssetRefs(p.markdown, mediaRefs)
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: p.key,
              Body: markdown,
              ContentType: 'text/markdown; charset=utf-8',
            }),
          )
          files.push({ docId: p.docId, title: p.title, filename: p.filename, key: p.key })
          result.pushed++
        } catch (e) {
          result.errors.push(`${p.filename}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // 全量推送时才清理陈旧文件与 media（按文档过滤时不删）
      if (!docIds || docIds.length === 0) {
        const manifest = buildArchiveManifest({ adapter: 's3', files, media: [...mediaRefs.values()] })
        const stale = staleArchiveKeys(previous, manifest)
        for (const key of stale) {
          try {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
          } catch (e) {
            result.errors.push(`delete ${key}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        const staleMedia = staleArchiveMedia(previous, manifest)
        for (const rel of staleMedia) {
          try {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${keyPrefix}${rel}` }))
          } catch (e) {
            result.errors.push(`delete ${rel}: ${e instanceof Error ? e.message : String(e)}`)
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

  async function listObjects(
    client: S3ClientLike,
    bucket: string,
    prefix: string,
  ): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined
    do {
      const res = (await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      )) as { Contents?: Array<{ Key?: string }>; IsTruncated?: boolean; NextContinuationToken?: string }
      for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key)
      token = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token)
    return keys
  }
}
