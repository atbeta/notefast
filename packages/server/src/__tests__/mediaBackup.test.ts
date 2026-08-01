import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BackupS3Config } from '@notefast/core'
import {
  uploadMissingMedia,
  restoreReferencedMedia,
  mediaExistsInS3,
  deleteMediaObject,
} from '../backup/mediaBackup'

/**
 * Media → S3 内容寻址同步：
 * - 上送幂等（本地已存在 S3 的跳过）、增量差集
 * - key = {prefix}media/<sha256>
 * - 恢复只拉引用集合；缺失（悬空引用）单独报告
 * - 删除/探测
 */

const CFG: BackupS3Config = {
  bucket: 'b',
  region: 'r',
  accessKeyId: 'k',
  secretAccessKey: 's',
  prefix: 'p',
}

/** 内存 S3 mock：List/Get/Put/Head/Delete 五种命令 */
function makeMockClient(objects: Map<string, string>) {
  return {
    async send(command: unknown) {
      const cmd = command as { constructor: { name: string }; input: Record<string, unknown> }
      const name = cmd.constructor.name
      if (name === 'ListObjectsV2Command') {
        const prefix = String(cmd.input.Prefix || '')
        const allKeys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
        return { Contents: allKeys.map((Key) => ({ Key })), IsTruncated: false }
      }
      if (name === 'GetObjectCommand') {
        const key = cmd.input.Key as string
        const body = objects.get(key)
        if (body === undefined) {
          const err = new Error(`missing ${key}`) as Error & { name: string }
          err.name = 'NoSuchKey'
          throw err
        }
        return { Body: { transformToByteArray: async () => Buffer.from(body) } }
      }
      if (name === 'PutObjectCommand') {
        const key = cmd.input.Key as string
        const body = cmd.input.Body as Buffer
        objects.set(key, body.toString('utf8'))
        return {}
      }
      if (name === 'HeadObjectCommand') {
        const key = cmd.input.Key as string
        if (!objects.has(key)) {
          const err = new Error(`missing ${key}`) as Error & { name: string }
          err.name = 'NoSuchKey'
          throw err
        }
        return {}
      }
      if (name === 'DeleteObjectCommand') {
        const key = cmd.input.Key as string
        objects.delete(key)
        return {}
      }
      throw new Error(`unexpected ${name}`)
    },
  } as never
}

describe('media backup (内容寻址 S3 同步)', () => {
  test('uploadMissingMedia 只上送差集（本地有 S3 无的），幂等', async () => {
    const objects = new Map<string, string>()
    const client = makeMockClient(objects)
    const dir = mkdtempSync(join('/tmp', 'nf-media-up-'))

    // 三个本地文件；其中一个已存在于 S3
    writeFileSync(join(dir, 'a'.repeat(64)), 'AAA')
    writeFileSync(join(dir, 'b'.repeat(64)), 'BBB')
    writeFileSync(join(dir, 'c'.repeat(64)), 'CCC')
    objects.set('p/media/' + 'a'.repeat(64), 'AAA') // 已存在 → 应跳过

    const r1 = await uploadMissingMedia(CFG, dir, { client })
    expect(r1.uploaded).toBe(2)
    expect(r1.skipped).toBe(1)
    expect(objects.has('p/media/' + 'b'.repeat(64))).toBe(true)
    expect(objects.has('p/media/' + 'c'.repeat(64))).toBe(true)
    // 幂等：重跑全部跳过
    const r2 = await uploadMissingMedia(CFG, dir, { client })
    expect(r2.uploaded).toBe(0)
    expect(r2.skipped).toBe(3)

    rmSync(dir, { recursive: true, force: true })
  })

  test('uploadMissingMedia 忽略非 sha256 文件', async () => {
    const objects = new Map<string, string>()
    const client = makeMockClient(objects)
    const dir = mkdtempSync(join('/tmp', 'nf-media-ign-'))
    writeFileSync(join(dir, 'not-a-hash.txt'), 'x')
    writeFileSync(join(dir, 'd'.repeat(64)), 'DDD')

    const r = await uploadMissingMedia(CFG, dir, { client })
    expect(r.uploaded).toBe(1)
    expect(objects.has('p/media/' + 'd'.repeat(64))).toBe(true)
    // 非哈希文件未被上送
    expect([...objects.keys()].some((k) => k.endsWith('not-a-hash.txt'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('restoreReferencedMedia 只拉引用集合，已存在跳过，缺失单独报告', async () => {
    const objects = new Map<string, string>()
    const client = makeMockClient(objects)
    const dir = mkdtempSync(join('/tmp', 'nf-media-restore-'))
    mkdirSync(dir, { recursive: true })

    objects.set('p/media/' + '1'.repeat(64), 'XXX')
    objects.set('p/media/' + '2'.repeat(64), 'YYY')
    // 3 缺失（悬空引用）
    writeFileSync(join(dir, '2'.repeat(64)), 'YYY') // 本地已有 → 跳过

    const r = await restoreReferencedMedia(CFG, dir, ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)], { client })
    expect(r.restored).toBe(1) // 只拉了 1
    expect(r.missing).toEqual(['3'.repeat(64)])
    expect(readFileSync(join(dir, '1'.repeat(64)), 'utf8')).toBe('XXX')

    rmSync(dir, { recursive: true, force: true })
  })

  test('mediaExistsInS3 / deleteMediaObject', async () => {
    const objects = new Map<string, string>()
    const client = makeMockClient(objects)
    objects.set('p/media/' + '4'.repeat(64), 'QQQ')

    expect(await mediaExistsInS3(CFG, '4'.repeat(64), { client })).toBe(true)
    expect(await mediaExistsInS3(CFG, '5'.repeat(64), { client })).toBe(false)

    await deleteMediaObject(CFG, '4'.repeat(64), { client })
    expect(objects.has('p/media/' + '4'.repeat(64))).toBe(false)
    expect(await mediaExistsInS3(CFG, '4'.repeat(64), { client })).toBe(false)
  })
})
