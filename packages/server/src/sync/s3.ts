/**
 * S3 Sync Adapter
 *
 * 把 NoteFast 数据库里的所有文档渲染成 Markdown 文件，推送到 S3 兼容对象存储。
 * 兼容：AWS S3 / Cloudflare R2 / MinIO / Backblaze B2 / 阿里云 OSS（endpoints）。
 *
 * 设计：
 * - 走 AWS SDK v3 标准签名 + 单次 PutObject（每篇笔记 KB 量级，不需要 multipart）
 * - 客户端通过 S3ClientLike 接口注入，测试可替换为 stub
 * - prefix 自动归一化（去尾部 slash）
 * - 文件名复用 localFs 的 sanitize 规则，保证跨 adapter 一致
 */

import { S3Client } from '@aws-sdk/client-s3'
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

/**
 * 抽象出 SDK 调用接口，让测试可以注入 stub。
 * 与 @aws-sdk/client-s3 的 S3Client.send(cmd) 形状兼容。
 */
export interface S3ClientLike {
  send<T>(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<T>
}

export interface CreateS3AdapterOptions {
  /** 自定义 client；缺省时按 cfg 创建真实 S3Client */
  client?: S3ClientLike
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

  const client: S3ClientLike = opts.client ??
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

  return {
    name: 's3',

    async info(): Promise<SyncInfo> {
      try {
        const res = await client.send({
          constructor: { name: 'HeadBucketCommand' },
          input: { Bucket: bucket },
        })
        return {
          extra: {
            bucket,
            region: cfg.region,
            endpoint: cfg.endpoint || '(default AWS)',
            prefix,
            forcePathStyle: cfg.forcePathStyle ?? false,
            ok: true,
            status: (res as { BucketRegion?: string }).BucketRegion ?? cfg.region,
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
      for (const doc of docs) {
        try {
          const rows = fetchDescendants(db, doc.id)
          const tree = buildBlockTree([doc, ...rows])
          const markdown = blocksToMarkdown(tree)
          const slug = sanitizeFilename(doc.content || 'untitled')
          const key = `${keyPrefix}${slug}.md`
          await client.send({
            constructor: { name: 'PutObjectCommand' },
            input: {
              Bucket: bucket,
              Key: key,
              Body: markdown,
              ContentType: 'text/markdown; charset=utf-8',
            },
          })
          result.pushed++
        } catch (e) {
          result.errors.push(`${doc.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return result
    },
  }
}
