/**
 * 同步协议数据面（方案 A：客户端与 Web 共享同一份 S3）
 *
 * publish（本端 → S3）：把本地 entity_changes 增量导出为 changes/ 分段 jsonl，
 * 并维护 manifest（last_seq）；定期生成全量 snapshot.db 供首次/超窗端拉取。
 * consume（S3 → 本端）：按 manifest 决定「增量合并」或「全量快照重建」，
 * 增量按 updated_at LWW 裁决后 upsert / tombstone 进本地库。
 *
 * 设计：
 * - 增量行 = 变更事件 + 变更后块状态（entity_changes 不存内容，重放需块内容）
 * - 合并直接用 SQL（不经 store hooks），避免同步触发 change feed → 双向循环
 * - S3 操作经注入 client（复用 mediaBackup 的可测模式）
 */

import type { S3Client } from '@aws-sdk/client-s3'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  buildChangesKey,
  buildSnapshotKey,
  buildSnapshotSeqKey,
  buildSyncManifestKey,
  CHANGES_PER_SEGMENT,
  SYNC_S3_DIR,
  type SyncBlockState,
  type SyncChange,
  type SyncManifest,
} from '@notefast/core'
import type { getDb } from '../db'
import { listChanges, getChangesAnchor } from '../store/changeFeed'
import { nowTimestamp } from '../store/blocks'
import { createLocalSnapshot, verifySnapshotFile } from '../backup/snapshot'
import { durableReplaceFile } from '../backup/durableFs'

export type Db = ReturnType<typeof getDb>

export interface SyncProtocolOptions {
  client?: S3Client
}

export interface PublishResult {
  /** 本次导出的变更条数 */
  changesExported: number
  /** 是否生成了新快照 */
  snapshotCreated: boolean
  lastSeq: number
}

export interface ConsumeResult {
  /** 采用的方式：全量快照 or 增量合并 */
  mode: 'full' | 'incremental'
  /** 增量合并时应用的行数 */
  applied?: number
  /** 跳过的行数（LWW 旧值 / 未知实体） */
  skipped?: number
  /** 快照锚点 seq（full 模式） */
  snapshotSeq?: number
  /** 合并后本地锚点（下一轮 consume 的 since） */
  nextSeq: number
}

export interface SyncState {
  /** 上次已发布到 S3 的 seq（不含） */
  publishedSeq: number
  /** 已消费的远端 seq（不含） */
  consumedSeq: number
}

// ───────────────────── S3 对象操作（注入 client）─────────────────────

async function putText(client: S3Client, bucket: string, key: string, body: string): Promise<void> {
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from(body), ContentType: 'application/octet-stream' }),
  )
}

async function getText(client: S3Client, bucket: string, key: string): Promise<string | null> {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const bytes = await res.Body?.transformToByteArray()
    return bytes ? Buffer.from(bytes).toString('utf8') : null
  } catch (e) {
    if ((e as { name?: string }).name === 'NoSuchKey') return null
    throw e
  }
}

async function listKeys(client: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    )
    for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key)
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)
  return keys
}

// ───────────────────── 快照（全量基线）─────────────────────

/**
 * 生成全量快照并上传 S3（VACUUM INTO → verify → upload snapshot.db + snapshot.seq）。
 * 供首次同步 / 增量超窗的端全量重建。返回快照锚点 seq。
 */
export async function publishSnapshot(
  db: Db,
  cfg: { bucket: string; prefix: string },
  client: S3Client,
  workDir: string,
): Promise<number> {
  const anchor = getChangesAnchor(db)
  const snap = await createLocalSnapshot(workDir)
  try {
    const bytes = readFileSync(snap.path)
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: buildSnapshotKey(cfg.prefix),
        Body: bytes,
        ContentType: 'application/x-sqlite3',
      }),
    )
    await putText(client, cfg.bucket, buildSnapshotSeqKey(cfg.prefix), String(anchor))
    return anchor
  } finally {
    // 快照文件清理交给调用方（workDir 由 publishSync 统一清理）
  }
}

// ───────────────────── 发布（本端 → S3）─────────────────────

/**
 * 发布增量：把 [publishedSeq, anchor] 区间导出为 changes/ 分段 jsonl。
 * 每段 CHANGES_PER_SEGMENT 条；追加 = 写新对象（文件名含 seq 区间，无需读改写）。
 * 返回新锚点（应写回本地 state）。
 */
export async function publishChanges(
  db: Db,
  cfg: { bucket: string; prefix: string },
  client: S3Client,
  publishedSeq: number,
): Promise<number> {
  const anchor = getChangesAnchor(db)
  if (anchor <= publishedSeq) return publishedSeq

  let seq = publishedSeq
  while (seq < anchor) {
    const rows = listChanges(db, { sinceSeq: seq, limit: CHANGES_PER_SEGMENT })
    if (rows.length === 0) break

    const lines: string[] = []
    for (const r of rows) {
      const change: SyncChange = { ...r }
      // 非 tombstone：附加块当前状态（join blocks；块可能已被软删 → 状态为空则发 tombstone）
      if (!r.is_erased) {
        const block = db
          .query('SELECT * FROM blocks WHERE id = ?')
          .get(r.entity_id) as SyncBlockState | undefined
        if (block && !block.ai_exclude) {
          change.block = block
        } else {
          change.is_erased = 1
        }
      }
      lines.push(JSON.stringify(change))
      seq = r.seq
    }
    const startSeq = rows[0]!.seq
    const endSeq = rows[rows.length - 1]!.seq
    await putText(client, cfg.bucket, buildChangesKey(cfg.prefix, startSeq, endSeq), lines.join('\n'))
  }
  return anchor
}

/** 更新 S3 manifest（last_seq = 发布后的锚点） */
export async function updateManifest(
  client: S3Client,
  cfg: { bucket: string; prefix: string },
  lastSeq: number,
  snapshotSeq: number,
): Promise<SyncManifest> {
  const manifest: SyncManifest = {
    app: 'notefast',
    kind: 'sync',
    version: 1,
    last_seq: lastSeq,
    snapshot_seq: snapshotSeq,
    updated_at: new Date().toISOString(),
  }
  await putText(client, cfg.bucket, buildSyncManifestKey(cfg.prefix), JSON.stringify(manifest))
  return manifest
}

export async function readManifest(
  client: S3Client,
  cfg: { bucket: string; prefix: string },
): Promise<SyncManifest | null> {
  const text = await getText(client, cfg.bucket, buildSyncManifestKey(cfg.prefix))
  if (!text) return null
  try {
    const m = JSON.parse(text) as SyncManifest
    if (m && m.app === 'notefast' && m.kind === 'sync' && m.version === 1) return m
  } catch { /* ignore */ }
  return null
}

// ───────────────────── 消费（S3 → 本端）─────────────────────

/**
 * 全量消费：下载 snapshot.db 重建本地库文件（替换）。超窗/首次用。
 * 返回快照锚点 seq。
 */
export async function consumeSnapshot(
  client: S3Client,
  cfg: { bucket: string; prefix: string },
  targetDbPath: string,
): Promise<number> {
  const seqText = await getText(client, cfg.bucket, buildSnapshotSeqKey(cfg.prefix))
  const snapshotSeq = seqText ? parseInt(seqText, 10) || 0 : 0

  const res = await client.send(
    new GetObjectCommand({ Bucket: cfg.bucket, Key: buildSnapshotKey(cfg.prefix) }),
  )
  const bytes = await res.Body?.transformToByteArray()
  if (!bytes) throw new Error('快照为空或不存在')

  // 临时文件校验后 durable 替换（与 backup restore 同模式）
  const tmp = targetDbPath + '.sync-incoming'
  writeFileSync(tmp, Buffer.from(bytes))
  verifySnapshotFile(tmp)
  durableReplaceFile(tmp, targetDbPath, readFileSync(tmp))
  return snapshotSeq
}

/**
 * Compaction：生成新快照（覆盖旧快照）后，删除所有旧 changes 段。
 * 快照已涵盖到锚点 seq，旧增量不再需要（消费端首次/超窗直接拉快照）。
 * 返回新快照锚点 seq。
 */
export async function compactChanges(
  db: Db,
  client: S3Client,
  cfg: { bucket: string; prefix: string },
  workDir: string,
): Promise<number> {
  // 1) 覆盖新快照（含当前锚点）
  const anchor = await publishSnapshot(db, cfg, client, workDir)
  // 2) 删除全部旧 changes 段（快照已兜底）
  const changesPrefix = `${cfg.prefix}${SYNC_S3_DIR}/changes/`
  const keys = await listKeys(client, cfg.bucket, changesPrefix)
  for (const key of keys) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }))
    } catch (e) {
      console.warn('[sync] compact 删除失败:', key, e instanceof Error ? e.message : e)
    }
  }
  return anchor
}

/** LWW 裁决：incoming 是否应覆盖本地（本地缺失 → 覆盖；时间更晚 → 覆盖） */
function shouldApply(
  db: Db,
  block: SyncBlockState,
): boolean {
  const local = db.query('SELECT updated_at FROM blocks WHERE id = ?').get(block.id) as
    | { updated_at: string }
    | undefined
  if (!local) return true
  return block.updated_at > local.updated_at
}

/**
 * 增量合并：下载 [consumedSeq, upToSeq] 区间所有 changes 段，逐行 LWW 裁决后 upsert / tombstone。
 * 用直接 SQL（不经 store hooks，避免 change feed 循环）。返回 applied/skipped 与本地新锚点。
 */
export async function consumeChanges(
  db: Db,
  client: S3Client,
  cfg: { bucket: string; prefix: string },
  consumedSeq: number,
  upToSeq: number,
): Promise<{ applied: number; skipped: number; nextSeq: number }> {
  const changesPrefix = `${cfg.prefix}${SYNC_S3_DIR}/changes/`
  const keys = (await listKeys(client, cfg.bucket, changesPrefix)).sort()

  let applied = 0
  let skipped = 0
  let nextSeq = consumedSeq

  const upsert = db.query(`
    INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, tags, status, ai_exclude, sort, level, is_deleted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      notebook_id = excluded.notebook_id,
      parent_id = excluded.parent_id,
      root_id = excluded.root_id,
      type = excluded.type,
      content = excluded.content,
      properties = excluded.properties,
      tags = excluded.tags,
      status = excluded.status,
      ai_exclude = excluded.ai_exclude,
      sort = excluded.sort,
      level = excluded.level,
      is_deleted = 0,
      updated_at = excluded.updated_at
  `)

  for (const key of keys) {
    const m = key.split('/').pop()?.match(/^(\d+)-(\d+)\.jsonl$/)
    if (!m) continue
    const startSeq = parseInt(m[1]!, 10)
    const endSeq = parseInt(m[2]!, 10)
    if (endSeq <= consumedSeq) continue // 已消费
    if (startSeq > upToSeq) break // 超出目标区间（按序已过）

    const text = await getText(client, cfg.bucket, key)
    if (!text) continue
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let change: SyncChange
      try {
        change = JSON.parse(line) as SyncChange
      } catch { skipped++; continue }
      if (change.seq <= consumedSeq || change.seq > upToSeq) continue

      if (change.is_erased) {
        db.query(
          `UPDATE blocks SET is_deleted = 1, delete_id = lower(hex(randomblob(16))), updated_at = ? WHERE id = ? AND is_deleted = 0`,
        ).run(nowTimestamp(), change.entity_id)
        applied++
      } else if (change.block && shouldApply(db, change.block)) {
        const b = change.block
        upsert.run(
          b.id, b.notebook_id, b.parent_id, b.root_id, b.type, b.content,
          b.properties ?? '{}', b.tags ?? '[]', b.status ?? 'note', b.ai_exclude ?? 0,
          b.sort, b.level, b.created_at ?? nowTimestamp(), b.updated_at,
        )
        applied++
      } else {
        skipped++
      }
      if (change.seq > nextSeq) nextSeq = change.seq
    }
    // 段整体消费完（含空行/跳过）：推进到段终点，避免同段重复拉
    if (endSeq > nextSeq) nextSeq = endSeq
  }
  return { applied, skipped, nextSeq }
}
