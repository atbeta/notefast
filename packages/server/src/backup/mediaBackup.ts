/**
 * Media → 对象存储 内容寻址同步
 *
 * 地位：既是灾备缺口修复（data/media 唯一丢失洞），也是多端同步自包含的前置基础设施。
 * 内容寻址（sha256）让这里天然：
 * - 幂等：同一图重复上送 = 同一 key，覆盖无害
 * - 增量：每次只上送「本地有而存储无」的差集
 * - 不可变：内容寻址的文件永不修改，无版本/冲突问题
 *
 * key：{mediaPrefix}<sha256>（mediaPrefix 含尾斜杠；备份与多端同步各自独立位置）
 *
 * 构建在 ObjectStore 抽象之上（当前为 S3 实现）。
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ObjectStore } from '../storage/objectStore'

/** media 对象所在目录（追加在用户配置前缀之后） */
export const MEDIA_S3_DIR = 'media'

export interface MediaBackupResult {
  /** 本次实际新上送的对象数（命中去重跳过的不计） */
  uploaded: number
  /** 已存在、本次跳过的对象数 */
  skipped: number
  /** 上送过程中失败的 key 列表（部分失败不中断整体） */
  errors: string[]
}

export interface MediaRestoreResult {
  /** 实际拉回并落盘的文件数 */
  restored: number
  /** 请求拉取但存储缺失的 key 列表（引用悬空） */
  missing: string[]
  errors: string[]
}

/** 归一化用户前缀并拼出 media 目录前缀（含尾斜杠），如 'test/media/' */
export function mediaPrefixFor(rawPrefix: string | undefined): string {
  const p = (rawPrefix || '').replace(/^\/+/, '').replace(/\/+$/, '')
  return p === '' ? `${MEDIA_S3_DIR}/` : `${p}/${MEDIA_S3_DIR}/`
}

/** 枚举存储上已存在的 media key（只读一次前缀，避免每个文件都 HEAD 一次） */
async function listExistingMediaKeys(store: ObjectStore, mediaPrefix: string): Promise<Set<string>> {
  const keys = new Set<string>()
  const listPrefix = mediaPrefix
  for (const key of await store.listObjects(listPrefix)) {
    const sha = key.slice(listPrefix.length)
    if (/^[0-9a-f]{64}$/.test(sha)) keys.add(sha)
  }
  return keys
}

/**
 * 把本地 media 目录中「尚未在存储」的文件上送（幂等）。key = 文件名（sha256）。
 * - 本地以 sha256 命名的文件才纳入（与 assets 表一致；游离文件也上送，无害）
 * - 逐个 put，失败记入 errors 不中断整体
 */
export async function uploadMissingMedia(
  store: ObjectStore,
  mediaPrefix: string,
  localMediaDir: string,
): Promise<MediaBackupResult> {
  // 一次性枚举已有 key，避免每文件 HEAD 一次（大 media 集合时成本差异显著）
  let existing = new Set<string>()
  try {
    existing = await listExistingMediaKeys(store, mediaPrefix)
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
      await store.putObject(`${mediaPrefix}${sha}`, readFileSync(path))
      result.uploaded++
    } catch (e) {
      result.errors.push(`${sha}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

/**
 * 把存储上被引用的 media 拉回本地（只拉引用集合，不拉已被 GC 的孤儿图）。
 * referencedIds：应从 assets 表推导（collectReferencedAssetIds）。
 * 已存在的本地文件跳过（内容寻址，命中即正确）。
 */
export async function restoreReferencedMedia(
  store: ObjectStore,
  mediaPrefix: string,
  localMediaDir: string,
  referencedIds: Iterable<string>,
): Promise<MediaRestoreResult> {
  const result: MediaRestoreResult = { restored: 0, missing: [], errors: [] }
  if (!existsSync(localMediaDir)) mkdirSync(localMediaDir, { recursive: true })

  for (const sha of referencedIds) {
    if (!/^[0-9a-f]{64}$/.test(sha)) continue
    if (existsSync(join(localMediaDir, sha))) continue
    try {
      const bytes = await store.getObject(`${mediaPrefix}${sha}`)
      if (!bytes) {
        result.missing.push(sha)
        continue
      }
      writeFileSync(join(localMediaDir, sha), Buffer.from(bytes))
      result.restored++
    } catch (e) {
      result.errors.push(`${sha}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

/** 检查单个 media 是否已存在（幂等上送前可选探测；通常走批量列举不需要） */
export async function mediaExists(store: ObjectStore, mediaPrefix: string, sha: string): Promise<boolean> {
  return (await store.getObject(`${mediaPrefix}${sha}`)) !== undefined
}

/** 删除一个 media 对象（清理孤儿图时用；慎重，仅当确认无引用） */
export async function deleteMediaObject(store: ObjectStore, mediaPrefix: string, sha: string): Promise<void> {
  await store.deleteObject(`${mediaPrefix}${sha}`)
}
