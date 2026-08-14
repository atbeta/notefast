/**
 * 对象存储抽象层
 *
 * 备份（全量快照）、多端同步（变更日志）、media 内容寻址共用的底层存储接口。
 * 唯一后端语义 = 对象（key → bytes）：
 * - 读：按 key 取对象，不存在返回 undefined
 * - 写：按 key 覆盖/创建
 * - 列：按前缀列举全部 key（自动翻页）
 * - 删：单个或批量
 *
 * 现实现：S3 / S3 兼容（R2、MinIO…）。WebDAV、LocalFS 等后续作为新 ObjectStore 实现接入。
 * key 为「相对 bucket 的完整对象键」（调用方用各自的前缀规则拼装，与本层无关）。
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

export type ObjectBody = string | Uint8Array

export interface ObjectStore {
  /** 校验后端可用（鉴权 / 连通性） */
  testConnection(): Promise<{ ok: boolean; error?: string }>
  /** 写入对象；覆盖已有。contentType 可选（S3/WebDAV 透传；LocalFS 忽略） */
  putObject(key: string, body: ObjectBody, contentType?: string): Promise<void>
  /** 读取对象；不存在返回 undefined */
  getObject(key: string): Promise<Uint8Array | undefined>
  /** 列举指定前缀下的全部对象键（含子前缀，自动翻页） */
  listObjects(prefix: string): Promise<string[]>
  /** 删除单个对象；不存在静默成功 */
  deleteObject(key: string): Promise<void>
  /** 批量删除；返回成功数与错误明细（逐个删除，部分失败不中断） */
  deleteObjects(keys: string[]): Promise<{ deleted: number; errors: string[] }>
}

/** 便捷：按 UTF-8 读文本；对象不存在返回 null */
export async function getObjectText(store: ObjectStore, key: string): Promise<string | null> {
  const bytes = await store.getObject(key)
  return bytes ? Buffer.from(bytes).toString('utf8') : null
}

// ───────────────────── S3 实现 ─────────────────────

export interface S3ObjectStoreConfig {
  bucket: string
  region: string
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle?: boolean
}

export function createS3ObjectStore(cfg: S3ObjectStoreConfig, injected?: S3Client): ObjectStore {
  const s3 =
    injected ??
    new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint || undefined,
      forcePathStyle: cfg.forcePathStyle ?? false,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    } satisfies S3ClientConfig)

  function isNoSuchKey(e: unknown): boolean {
    return (e as { name?: string }).name === 'NoSuchKey'
  }

  return {
    async testConnection() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: cfg.bucket }))
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },

    async putObject(key, body, contentType) {
      await s3.send(new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      }))
    },

    async getObject(key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }))
        const bytes = await res.Body?.transformToByteArray()
        return bytes ? new Uint8Array(bytes) : undefined
      } catch (e) {
        if (isNoSuchKey(e)) return undefined
        throw e
      }
    },

    async listObjects(prefix) {
      const keys: string[] = []
      let token: string | undefined
      do {
        const res = await s3.send(
          new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token }),
        )
        for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key)
        token = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (token)
      return keys
    },

    async deleteObject(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }))
    },

    async deleteObjects(keys) {
      let deleted = 0
      const errors: string[] = []
      for (const key of keys) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }))
          deleted++
        } catch (e) {
          errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return { deleted, errors }
    },
  }
}
