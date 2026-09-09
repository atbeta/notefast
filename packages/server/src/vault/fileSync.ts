/**
 * vault 文件同步引擎（RFC 0004）
 *
 * 远端布局（用户自有对象存储 / 本地目录）：
 *   <prefix>/meta.json                vault 身份（防串库）
 *   <prefix>/blobs/<sha[0:2]>/<sha>   内容寻址文件字节
 *   <prefix>/manifests/<device>.json  每设备一份清单分片
 *
 * push：扫描本地 → 与 `vault_sync_state` 比对 → 上传缺失 blob → 覆盖本端分片
 * pull：合并所有分片 → 按 `updated_at` LWW → 下载 / 快进 / 冲突副本
 *
 * 本模块只做文件层；落盘后的入库由 watcher / light reconcile 负责。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  isNewerVaultSyncEntry,
  type VaultSyncEntry,
  type VaultSyncMeta,
  type VaultSyncShard,
} from '@notefast/core'
import type { getDb } from '../db'
import { getObjectText, type ObjectStore } from '../storage/objectStore'
import { isIgnoredRelPath } from './paths'
import { listVaultSyncState, upsertVaultSyncState, type VaultSyncStateRow } from '../store/vaultSyncState'

type Db = ReturnType<typeof getDb>

/** 可同步的资源扩展名（与 `vault/raw` 白名单一致）；`.md` 始终可同步 */
export const SYNC_ASSET_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'])

export function isSyncableRelPath(relPath: string): boolean {
  const lower = relPath.toLowerCase()
  if (lower.endsWith('.md')) return true
  const ext = lower.includes('.') ? lower.split('.').pop()! : ''
  return SYNC_ASSET_EXT.has(ext)
}

export interface SyncableFile {
  rel_path: string
  abs_path: string
  size: number
  mtime_ms: number
}

/** 递归列出可同步文件（跳过忽略目录与符号链接）；只 stat，不读内容 */
export async function listSyncableFiles(root: string, ignore: string[]): Promise<SyncableFile[]> {
  const out: SyncableFile[] = []
  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (depth > 12) return
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (isIgnoredRelPath(rel, ignore)) continue
      if (entry.isSymbolicLink()) continue
      const abs = join(absDir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, rel, depth + 1)
      } else if (entry.isFile() && isSyncableRelPath(rel)) {
        const st = statSync(abs, { throwIfNoEntry: false })
        if (!st) continue
        out.push({ rel_path: rel, abs_path: abs, size: st.size, mtime_ms: Math.round(st.mtimeMs) })
      }
    }
  }
  await walk(root, '', 0)
  return out
}

export async function sha256File(absPath: string): Promise<string> {
  const bytes = await Bun.file(absPath).arrayBuffer()
  return createHash('sha256').update(new Uint8Array(bytes)).digest('hex')
}

export function vaultBlobKey(prefix: string, sha: string): string {
  return `${prefix}blobs/${sha.slice(0, 2)}/${sha}`
}

export function vaultManifestKey(prefix: string, deviceId: string): string {
  return `${prefix}manifests/${deviceId}.json`
}

export function vaultMetaKey(prefix: string): string {
  return `${prefix}meta.json`
}

export interface FileSyncDeps {
  store: ObjectStore
  prefix: string
  /** vault 根目录绝对路径 */
  root: string
  ignore: string[]
  deviceId: string
  db: Db
}

// ───────────────────── 远端读取 / 写入 ─────────────────────

/** 读全部设备分片并合并成「路径 → 条目」视图 */
export async function readRemoteEntries(store: ObjectStore, prefix: string): Promise<Map<string, VaultSyncEntry>> {
  const merged = new Map<string, VaultSyncEntry>()
  const keys = await store.listObjects(`${prefix}manifests/`)
  for (const key of keys) {
    if (!key.endsWith('.json')) continue
    const text = await getObjectText(store, key)
    if (!text) continue
    let shard: VaultSyncShard
    try {
      shard = JSON.parse(text) as VaultSyncShard
    } catch {
      continue
    }
    for (const entry of shard.entries ?? []) {
      if (!entry?.rel_path) continue
      const prev = merged.get(entry.rel_path)
      if (!prev || isNewerVaultSyncEntry(entry, prev)) merged.set(entry.rel_path, entry)
    }
  }
  return merged
}

/** 读本端分片（不存在返回空表） */
async function readOwnShard(store: ObjectStore, prefix: string, deviceId: string): Promise<VaultSyncShard> {
  const text = await getObjectText(store, vaultManifestKey(prefix, deviceId))
  if (text) {
    try {
      const parsed = JSON.parse(text) as VaultSyncShard
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) return parsed
    } catch {
      /* 坏分片当作空表重建 */
    }
  }
  return { version: 1, device_id: deviceId, updated_at: new Date(0).toISOString(), entries: [] }
}

/** 覆盖本端分片（写者唯一，无并发写冲突） */
export async function writeOwnShard(
  store: ObjectStore,
  prefix: string,
  deviceId: string,
  entries: VaultSyncEntry[],
): Promise<void> {
  const shard: VaultSyncShard = {
    version: 1,
    device_id: deviceId,
    updated_at: new Date().toISOString(),
    entries,
  }
  await store.putObject(
    vaultManifestKey(prefix, deviceId),
    new TextEncoder().encode(JSON.stringify(shard, null, 2)),
    'application/json',
  )
}

/**
 * 确保远端 vault 身份存在并返回它。
 * 首次调用创建；已有则校验，`vault_id` 不一致直接抛错（防串库）。
 */
export async function ensureVaultSyncMeta(
  store: ObjectStore,
  prefix: string,
  localVaultId: string | null,
): Promise<VaultSyncMeta> {
  const key = vaultMetaKey(prefix)
  const text = await getObjectText(store, key)
  if (text) {
    const meta = JSON.parse(text) as VaultSyncMeta
    if (meta?.version !== 1 || !meta.vault_id) throw new Error('远端 meta.json 非法，拒绝同步')
    if (localVaultId && meta.vault_id !== localVaultId) {
      throw new Error(`远端 vault_id 与本端不一致（${meta.vault_id} ≠ ${localVaultId}），拒绝混库`)
    }
    return meta
  }
  const meta: VaultSyncMeta = {
    version: 1,
    vault_id: localVaultId ?? crypto.randomUUID(),
    created_at: new Date().toISOString(),
  }
  await store.putObject(key, new TextEncoder().encode(JSON.stringify(meta, null, 2)), 'application/json')
  return meta
}

// ───────────────────── push ─────────────────────

export interface VaultPushResult {
  scanned: number
  /** 内容有变化、已写入远端清单的文件数 */
  changed: number
  uploaded_blobs: number
  tombstones: number
  /** 只 mtime 变、内容未变的文件（刷新基线，不产生远端条目） */
  touched_only: number
}

export async function pushVaultFiles(deps: FileSyncDeps): Promise<VaultPushResult> {
  const { store, prefix, root, ignore, deviceId, db } = deps
  const local = await listSyncableFiles(root, ignore)
  const state = new Map<string, VaultSyncStateRow>(listVaultSyncState(db).map((r) => [r.rel_path, r]))
  const updates: VaultSyncEntry[] = []
  const baselines: Array<{ rel_path: string; synced_blob: string | null; synced_size: number; synced_mtime_ms: number }> = []
  let uploaded = 0
  let changed = 0
  let touchedOnly = 0

  const localPaths = new Set<string>()
  for (const file of local) {
    localPaths.add(file.rel_path)
    const prev = state.get(file.rel_path)
    // 快速路径：stat 与基线一致 → 内容必然没变（不必读文件）
    if (
      prev &&
      prev.synced_blob &&
      prev.synced_size === file.size &&
      prev.synced_mtime_ms === file.mtime_ms
    ) {
      continue
    }
    const sha = await sha256File(file.abs_path)
    if (prev && prev.synced_blob === sha) {
      // 内容没变（例如 touch）：只刷新基线
      baselines.push({
        rel_path: file.rel_path,
        synced_blob: sha,
        synced_size: file.size,
        synced_mtime_ms: file.mtime_ms,
      })
      touchedOnly++
      continue
    }
    const key = vaultBlobKey(prefix, sha)
    const existing = await store.getObject(key)
    if (!existing) {
      await store.putObject(key, new Uint8Array(await Bun.file(file.abs_path).arrayBuffer()))
      uploaded++
    }
    updates.push({
      rel_path: file.rel_path,
      blob: sha,
      size: file.size,
      mtime_ms: file.mtime_ms,
      updated_at: new Date(file.mtime_ms).toISOString(),
      device_id: deviceId,
    })
    baselines.push({
      rel_path: file.rel_path,
      synced_blob: sha,
      synced_size: file.size,
      synced_mtime_ms: file.mtime_ms,
    })
    changed++
  }

  // 基线里存在、本地已消失 → tombstone（保留条目，其他设备才能得知删除）
  let tombstones = 0
  const nowIso = new Date().toISOString()
  for (const [relPath, prev] of state) {
    if (localPaths.has(relPath)) continue
    if (prev.synced_blob === null) continue // 已经推过 tombstone
    updates.push({
      rel_path: relPath,
      blob: null,
      size: 0,
      mtime_ms: 0,
      updated_at: nowIso,
      device_id: deviceId,
    })
    baselines.push({ rel_path: relPath, synced_blob: null, synced_size: 0, synced_mtime_ms: 0 })
    tombstones++
  }

  if (updates.length > 0) {
    const shard = await readOwnShard(store, prefix, deviceId)
    const byPath = new Map(shard.entries.map((e) => [e.rel_path, e]))
    for (const entry of updates) byPath.set(entry.rel_path, entry)
    await writeOwnShard(store, prefix, deviceId, [...byPath.values()])
  }
  upsertVaultSyncState(db, baselines)

  return { scanned: local.length, changed, uploaded_blobs: uploaded, tombstones, touched_only: touchedOnly }
}

// ───────────────────── pull ─────────────────────

export interface VaultPullResult {
  remote_entries: number
  /** 落盘（新建或快进覆盖）的文件数 */
  applied: number
  /** 删除并移入 .trash 的文件数 */
  deleted: number
  unchanged: number
  /** 冲突副本的 vault 相对路径 */
  conflicts: string[]
  /** 远端 blob 缺失等异常 */
  errors: string[]
}

function trashRelPath(root: string, relPath: string): void {
  const abs = join(root, relPath)
  if (!existsSync(abs)) return
  let dest = join(root, '.trash', ...relPath.split('/'))
  if (existsSync(dest)) dest = dest.replace(/(\.[^.]+)?$/, `.${Date.now()}$1`)
  mkdirSync(dirname(dest), { recursive: true })
  renameSync(abs, dest)
}

function writeFileAtomic(absPath: string, bytes: Uint8Array): void {
  mkdirSync(dirname(absPath), { recursive: true })
  const tmp = `${absPath}.${process.pid}.${Date.now()}.nf-sync-tmp`
  writeFileSync(tmp, bytes)
  renameSync(tmp, absPath)
}

function conflictStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** `<stem>.notefast-conflict-<device8>-<ts>.<ext>`（与写回冲突副本同形） */
export function conflictCopyRelPath(root: string, relPath: string, deviceId: string): string {
  const slash = relPath.lastIndexOf('/')
  const dir = slash >= 0 ? relPath.slice(0, slash + 1) : ''
  const name = slash >= 0 ? relPath.slice(slash + 1) : relPath
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = `${dir}${stem}.notefast-conflict-${deviceId.slice(0, 8)}-${conflictStamp()}${ext}`
  let n = 2
  while (existsSync(join(root, candidate))) {
    candidate = `${dir}${stem}.notefast-conflict-${deviceId.slice(0, 8)}-${conflictStamp()}-${n}${ext}`
    n++
  }
  return candidate
}

export async function pullVaultFiles(deps: FileSyncDeps): Promise<VaultPullResult> {
  const { store, prefix, root, deviceId, db } = deps
  const remote = await readRemoteEntries(store, prefix)
  const state = new Map<string, VaultSyncStateRow>(listVaultSyncState(db).map((r) => [r.rel_path, r]))
  const result: VaultPullResult = {
    remote_entries: remote.size,
    applied: 0,
    deleted: 0,
    unchanged: 0,
    conflicts: [],
    errors: [],
  }
  const baselines: Array<{ rel_path: string; synced_blob: string | null; synced_size: number; synced_mtime_ms: number }> = []

  for (const [relPath, entry] of remote) {
    if (!isSyncableRelPath(relPath)) continue
    const abs = join(root, relPath)
    const localExists = existsSync(abs)
    const base = state.get(relPath)?.synced_blob ?? null

    // 远端 tombstone
    if (entry.blob === null) {
      if (!localExists) {
        result.unchanged++
        if (!state.has(relPath)) {
          baselines.push({ rel_path: relPath, synced_blob: null, synced_size: 0, synced_mtime_ms: 0 })
        }
        continue
      }
      const localSha = await sha256File(abs)
      if (localSha === base) {
        trashRelPath(root, relPath)
        baselines.push({ rel_path: relPath, synced_blob: null, synced_size: 0, synced_mtime_ms: 0 })
        result.deleted++
      } else {
        // 本地有未推送改动：保留本地（下次 push 会把它带回来）
        result.conflicts.push(relPath)
      }
      continue
    }

    // 远端没变（等于基线）→ 本地领先，交给 push
    if (base && entry.blob === base) {
      result.unchanged++
      continue
    }

    const localSha = localExists ? await sha256File(abs) : null
    if (localSha === entry.blob) {
      baselines.push({
        rel_path: relPath,
        synced_blob: entry.blob,
        synced_size: entry.size,
        synced_mtime_ms: entry.mtime_ms,
      })
      result.unchanged++
      continue
    }

    const bytes = await store.getObject(vaultBlobKey(prefix, entry.blob))
    if (!bytes) {
      result.errors.push(`${relPath}: 远端缺少 blob ${entry.blob.slice(0, 8)}`)
      continue
    }

    if (!localExists || localSha === base) {
      writeFileAtomic(abs, bytes)
      result.applied++
    } else {
      // 双方都改过 → 时间新者为当前文件，旧者留冲突副本
      const localMtime = statSync(abs).mtimeMs
      const remoteNewer = Date.parse(entry.updated_at) > localMtime
      const copyRel = conflictCopyRelPath(root, relPath, deviceId)
      if (remoteNewer) {
        copyFileSync(abs, join(root, copyRel))
        writeFileAtomic(abs, bytes)
      } else {
        writeFileAtomic(join(root, copyRel), bytes)
      }
      result.conflicts.push(copyRel)
    }
    baselines.push({
      rel_path: relPath,
      synced_blob: entry.blob,
      synced_size: entry.size,
      synced_mtime_ms: entry.mtime_ms,
    })
  }

  upsertVaultSyncState(db, baselines)
  return result
}

/** 读取远端 vault 身份（不创建） */
export async function readVaultSyncMeta(store: ObjectStore, prefix: string): Promise<VaultSyncMeta | null> {
  const text = await getObjectText(store, vaultMetaKey(prefix))
  if (!text) return null
  try {
    return JSON.parse(text) as VaultSyncMeta
  } catch {
    return null
  }
}

/** 读文件字节（供测试 / 诊断） */
export function readLocalFileSync(absPath: string): Uint8Array {
  return new Uint8Array(readFileSync(absPath))
}
