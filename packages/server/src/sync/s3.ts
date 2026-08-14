/**
 * S3 Sync Adapter — Markdown 单向归档
 *
 * 存储操作经 ObjectStore 抽象层（createS3ObjectStore），推送流程与
 * WebDAV / LocalFS 共用 sync/archivePush 的 pushArchiveViaStore；
 * info()（HeadBucket 语义）保留在适配器内。
 */

import {
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  type SyncAdapter,
  type SyncInfo,
  type SyncResult,
  type PushOptions,
  type S3LocationConfig,
} from '@notefast/core'
import { createS3ObjectStore, type ObjectStore } from '../storage/objectStore'
import { pushArchiveViaStore } from './archivePush'

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
  const store: ObjectStore = createS3ObjectStore(
    { ...s3 },
    client as unknown as S3Client | undefined,
  )

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
      return pushArchiveViaStore(store, 's3', normalizedPrefix, options)
    },
  }
}
