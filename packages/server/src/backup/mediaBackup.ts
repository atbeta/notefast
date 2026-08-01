/**
 * Media → S3 内容寻址同步
 *
 * 地位：既是灾备缺口修复（data/media 唯一丢失洞），也是同步协议（方案 A：客户端与 Web
 * 共享 S3）的前置基础设施。内容寻址（sha256）让这里天然：
 * - 幂等：同一图重复上送 = 同一 key，S3 put 覆盖无害
 * - 增量：每次只上送「本地有而 S3 没有」的差集
 * - 不可变：内容寻址的文件永不修改，无版本/冲突问题
 *
 * S3 key：{prefix}media/<sha256>（与 backup 的 snapshots/ 并列，独立前缀便于列出/清理）
 *
 * 与备份的关系：
 * - 备份（snapshot.db）是「库的一致性快照」；media 是「图的内容寻址集合」
 * - 恢复点一致性 = 库 + 同一时点被引用 media 全集（见 restoreAll 只拉引用集合）
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BackupS3Config } from '@notefast/core'
import { normalizeBackupPrefix } from '@notefast/core'

/** media 对象在 S3 的 key 前缀（追加在用户配置的 prefix 之后） */
export const MEDIA_S3_DIR = 'media'

export interface MediaBackupResult {
  /** 本次实际新上送的对象数（命中去重跳过的不计） */
  uploaded: number
  /** 已存在于 S3、本次跳过的对象数 */
  skipped: number
  /** 上送过程中失败的 key 列表（部分失败不中断整体） */
  errors: string[]
}

export interface MediaRestoreResult {
  /** 实际拉回并落盘的文件数 */
  restored: number
  /** 请求拉取但 S3 缺失的 key 列表（引用悬空） */
  missing: string[]
  errors: string[]
}

function createClient(cfg: BackupS3Config, injected?: S3Client): S3Client {
  if (injected) return injected
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint || undefined,
    forcePathStyle: cfg.forcePathStyle ?? false,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  } satisfies S3ClientConfig)
}

function mediaKey(prefix: string, sha: string): string {
  return `${prefix}${MEDIA_S3_DIR}/${sha}`
}

/** 测试用：允许注入 mock S3Client（与 backup.test 的 createS3Store client 注入一致） */
export interface MediaBackupOptions {
  client?: S3Client
}

/** 枚举 S3 上已存在的 media key（只读一次前缀，避免每个文件都 HEAD 一次） */
async function listExistingMediaKeys(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<Set<string>> {
  const keys = new Set<string>()
  let token: string | undefined
  const listPrefix = `${prefix}${MEDIA_S3_DIR}/`
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: listPrefix,
        ContinuationToken: token,
      }),
    )
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue
      const sha = obj.Key.slice(listPrefix.length)
      if (/^[0-9a-f]{64}$/.test(sha)) keys.add(sha)
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)
  return keys
}

/**
 * 把本地 media 目录中「尚未在 S3」的文件上送（幂等）。key = 文件名（sha256）。
 * - 本地以 sha256 命名的文件才纳入（与 assets 表一致；游离文件也上送，无害）
 * - 逐个 put，失败记入 errors 不中断整体
 */
export async function uploadMissingMedia(
  cfg: BackupS3Config,
  localMediaDir: string,
  opts: MediaBackupOptions = {},
): Promise<MediaBackupResult> {
  const client = createClient(cfg, opts.client)
  const prefix = normalizeBackupPrefix(cfg.prefix)

  // 一次性枚举 S3 已有 key，避免每文件 HEAD 一次（大 media 集合时成本差异显著）
  let existing = new Set<string>()
  try {
    existing = await listExistingMediaKeys(client, cfg.bucket, prefix)
  } catch (e) {
    // 列举失败（bucket 无该前缀也视为空）——回退为空集，逐文件 put（幂等仍安全）
    console.warn('[mediaBackup] list existing failed, fall back to per-file put:', e instanceof Error ? e.message : e)
  }

  const result: MediaBackupResult = { uploaded: 0, skipped: 0, errors: [] }
  if (!existsSync(localMediaDir)) return result

  const files = readdirSync(localMediaDir).filter((f) => /^[0-9a-f]{64}$/.test(f))
  for (const sha of files) {
    if (existing.has(sha)) {
      result.skipped++
      continue
    }
    try {
      const path = join(localMediaDir, sha)
      const body = readFileSync(path)
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: mediaKey(prefix, sha),
          Body: body,
          ContentType: 'application/octet-stream',
          Metadata: { sha256: sha, size: String(statSync(path).size) },
        }),
      )
      result.uploaded++
    } catch (e) {
      result.errors.push(`${sha}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

/**
 * 把 S3 上被引用的 media 拉回本地（只拉引用集合，不拉已被 GC 的孤儿图）。
 * referencedIds：应从 assets 表推导（collectReferencedAssetIds）。
 * 已存在的本地文件跳过（内容寻址，命中即正确）。
 */
export async function restoreReferencedMedia(
  cfg: BackupS3Config,
  localMediaDir: string,
  referencedIds: Iterable<string>,
  opts: MediaBackupOptions = {},
): Promise<MediaRestoreResult> {
  const client = createClient(cfg, opts.client)
  const prefix = normalizeBackupPrefix(cfg.prefix)
  const result: MediaRestoreResult = { restored: 0, missing: [], errors: [] }
  if (!existsSync(localMediaDir)) mkdirSync(localMediaDir, { recursive: true })

  for (const sha of referencedIds) {
    if (!/^[0-9a-f]{64}$/.test(sha)) continue
    if (existsSync(join(localMediaDir, sha))) continue
    try {
      const res = await client.send(
        new GetObjectCommand({ Bucket: cfg.bucket, Key: mediaKey(prefix, sha) }),
      )
      const bytes = await res.Body?.transformToByteArray()
      if (!bytes) {
        result.missing.push(sha)
        continue
      }
      writeFileSync(join(localMediaDir, sha), Buffer.from(bytes))
      result.restored++
    } catch (e) {
      // 404 = S3 上没有这份图（引用悬空）；其它错误记 errors
      if ((e as { name?: string }).name === 'NoSuchKey') result.missing.push(sha)
      else result.errors.push(`${sha}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

/** 检查单个 media 是否已在 S3（幂等上送前可选探测；通常走批量列举不需要） */
export async function mediaExistsInS3(cfg: BackupS3Config, sha: string, opts: MediaBackupOptions = {}): Promise<boolean> {
  const client = createClient(cfg, opts.client)
  const prefix = normalizeBackupPrefix(cfg.prefix)
  try {
    await client.send(
      new HeadObjectCommand({ Bucket: cfg.bucket, Key: mediaKey(prefix, sha) }),
    )
    return true
  } catch {
    return false
  }
}

/** 删除一个 media 对象（清理孤儿图时用；慎重，仅当确认无引用） */
export async function deleteMediaObject(cfg: BackupS3Config, sha: string, opts: MediaBackupOptions = {}): Promise<void> {
  const client = createClient(cfg, opts.client)
  const prefix = normalizeBackupPrefix(cfg.prefix)
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: mediaKey(prefix, sha) }))
}
