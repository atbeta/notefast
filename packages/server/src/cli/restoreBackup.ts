/**
 * 停服务恢复 CLI
 *
 * 用法：
 *   bun --filter @notefast/server backup:restore -- \
 *     --data-dir ./data --object-key nf/snapshots/....db --yes
 *
 * 必须先停止 NoteFast 服务再执行。本 CLI 不做「库是否占用」探测：
 * WAL 下主动占锁既不可靠，也可能干扰仍在运行的实例。
 */

import { existsSync, mkdirSync, renameSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertSchemaCompatible,
  buildManifestObjectKey,
  CURRENT_SCHEMA_VERSION,
  emptyBackupConfig,
  isBackupManifest,
  type BackupManifest,
  type BackupPersistedConfig,
} from '@notefast/core'
import { Database } from 'bun:sqlite'
import { createS3Store } from '../backup/s3Store'
import { durableReplaceFile } from '../backup/durableFs'
import { hashFile, verifySnapshotFile } from '../backup/snapshot'
import { restoreReferencedMedia } from '../backup/mediaBackup'

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--yes' || a === '-y') {
      out.yes = true
      continue
    }
    if (a === '--dry-run') {
      out.dryRun = true
      continue
    }
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1]
      if (val && !val.startsWith('--')) {
        out[key] = val
        i++
      } else {
        out[key] = true
      }
    }
  }
  return out
}

function loadBackupConfig(dataDir: string): BackupPersistedConfig {
  const path = join(dataDir, 'backup.config.json')
  if (!existsSync(path)) return emptyBackupConfig()
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as BackupPersistedConfig
  } catch {
    return emptyBackupConfig()
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = String(args['data-dir'] || process.env.DATA_DIR || './data')
  const objectKey = String(args['object-key'] || args.objectKey || '')
  const dryRun = Boolean(args.dryRun)
  const yes = Boolean(args.yes)

  if (!objectKey) {
    console.error('用法: backup:restore --data-dir <dir> --object-key <key> [--yes] [--dry-run]')
    process.exit(2)
  }
  if (!yes && !dryRun) {
    console.error('拒绝执行：请添加 --yes 确认，或使用 --dry-run 预演')
    process.exit(2)
  }

  const cfg = loadBackupConfig(dataDir)
  if (!cfg.s3) {
    console.error('未找到 backup.config.json 中的 S3 配置')
    process.exit(1)
  }

  const store = createS3Store(cfg.s3)
  const manifestKey = buildManifestObjectKey(objectKey)
  const workDir = join(dataDir, '.restore-tmp')
  mkdirSync(workDir, { recursive: true })
  const tmpDb = join(workDir, 'restore.db')
  const tmpManifest = join(workDir, 'restore.manifest.json')

  console.log(`下载 manifest: ${manifestKey}`)
  await store.downloadObject(manifestKey, tmpManifest)
  const manifest = JSON.parse(readFileSync(tmpManifest, 'utf-8')) as BackupManifest
  if (!isBackupManifest(manifest)) {
    console.error('无效 manifest')
    process.exit(1)
  }
  if (manifest.objectKey !== objectKey) {
    console.error(`manifest.objectKey (${manifest.objectKey}) 与参数不一致`)
    process.exit(1)
  }

  assertSchemaCompatible(manifest.schemaVersion, CURRENT_SCHEMA_VERSION)

  console.log(`下载快照: ${objectKey}`)
  await store.downloadObject(objectKey, tmpDb)

  const sha = await hashFile(tmpDb)
  if (sha !== manifest.sha256) {
    console.error(`SHA-256 不匹配: 期望 ${manifest.sha256}，实际 ${sha}`)
    process.exit(1)
  }

  const verified = verifySnapshotFile(tmpDb)
  assertSchemaCompatible(verified.schemaVersion, CURRENT_SCHEMA_VERSION)

  const targetDb = join(dataDir, 'notefast.db')
  const wal = targetDb + '-wal'
  const shm = targetDb + '-shm'

  console.log('校验通过:')
  console.log(`  schema=${verified.schemaVersion} size=${manifest.sizeBytes} sha256=${sha.slice(0, 12)}…`)
  console.log('请确认 NoteFast 服务已停止（本工具不做占用探测）。')

  if (dryRun) {
    console.log('[dry-run] 未修改任何本地文件')
    rmSync(workDir, { recursive: true, force: true })
    return
  }

  const rollbackDir = join(dataDir, `rollback-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(rollbackDir, { recursive: true })

  for (const f of [targetDb, wal, shm]) {
    if (existsSync(f)) {
      renameSync(f, join(rollbackDir, f.split('/').pop()!))
    }
  }

  const staging = join(dataDir, 'notefast.db.restoring')
  durableReplaceFile(staging, targetDb, readFileSync(tmpDb))

  verifySnapshotFile(targetDb)
  console.log(`恢复完成 → ${targetDb}`)
  console.log(`本地回滚副本 → ${rollbackDir}`)

  // ── media 拉回：从恢复出的库推导被引用 sha256，只拉引用集合 ──
  try {
    const mediaDir = join(dataDir, 'media')
    const refDb = new Database(targetDb, { readonly: true })
    let refs: string[] = []
    try {
      const rows = refDb
        .query("SELECT DISTINCT content FROM blocks WHERE content LIKE '%asset:%'")
        .all() as Array<{ content: string }>
      const set = new Set<string>()
      for (const r of rows) {
        for (const m of r.content.matchAll(/asset:([0-9a-f]{64})/g)) set.add(m[1]!)
      }
      refs = [...set]
    } finally {
      refDb.close()
    }
    console.log(`media 引用集合: ${refs.length} 张图`)
    if (!dryRun) {
      const mediaRes = await restoreReferencedMedia(cfg.s3, mediaDir, refs)
      console.log(`media 恢复: 拉回 ${mediaRes.restored}，本地已有跳过，缺失 ${mediaRes.missing.length}`)
      if (mediaRes.missing.length > 0) {
        console.warn(`⚠️  以下图片在 S3 缺失（引用悬空）: ${mediaRes.missing.slice(0, 5).join(', ')}${mediaRes.missing.length > 5 ? '…' : ''}`)
      }
      if (mediaRes.errors.length > 0) console.warn(`media 恢复失败: ${mediaRes.errors.length} 个`)
    } else {
      console.log('[dry-run] media 未拉回（仅报告引用数量）')
    }
  } catch (e) {
    // media 恢复失败不阻断库恢复本身（文字优先；图可后续手动补）
    console.warn('media 恢复失败（库已恢复）:', e instanceof Error ? e.message : e)
  }

  rmSync(workDir, { recursive: true, force: true })
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
