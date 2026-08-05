/**
 * AssetStore — 图片唯一主数据源
 *
 * 设计（与 AGENTS.md 一致）：
 * - 内容寻址：asset id = 内容 sha256。同一图片重复上传 = 同一 id，天然去重幂等
 * - 文件落盘 data/media/<id>，SQLite 只存元数据（assets 表），不存 BLOB
 * - 引用关系不建关联表：真值在 markdown 内容里（asset:<id>），用 SQL LIKE 扫描推导，
 *   无对账代码、无漂移可能
 * - 孤儿回收：引用扫描 + 宽限期，手动触发（POST /assets/gc）
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db'
import type { ImageUploadConfig } from '@notefast/core'

export const ASSET_REF_PREFIX = 'asset:'
const MEDIA_DIR_NAME = 'media'
/** 上传大小上限 20MB */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024
/** 孤儿回收宽限期：新上传未满 7 天的一律保留（防「刚上传还没写进文档」被误删） */
export const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000

let mediaDir = ''

export function initAssetStore(dataDir: string): void {
  mediaDir = join(dataDir, MEDIA_DIR_NAME)
  if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true })
}

/** media 目录路径（initAssetStore 后可用）；未初始化时返回 null */
export function getMediaDir(): string | null {
  return mediaDir || null
}

export interface AssetMeta {
  id: string
  mime: string
  size: number
  created_at: string
  /** 图床外链（自动上传模式成功后写入；无则本地读取） */
  remote_url?: string | null
}

/** 当前生效的图床上传配置（initImageUploadConfig 后由 app 注入） */
let uploadConfig: ImageUploadConfig | null = null

export function setImageUploadConfig(cfg: ImageUploadConfig | null): void {
  uploadConfig = cfg
}

/** 保存图片（幂等去重）；返回元数据。dedup=true 表示命中已有内容未重复写盘 */
export function saveAsset(buf: Buffer, mime: string): { meta: AssetMeta; dedup: boolean } {
  const id = createHash('sha256').update(buf).digest('hex')
  const db = getDb()
  const existing = db.query('SELECT id, mime, size, created_at FROM assets WHERE id = ?').get(id) as AssetMeta | undefined
  if (existing && existsSync(join(mediaDir, id))) {
    return { meta: existing, dedup: true }
  }
  writeFileSync(join(mediaDir, id), buf)
  const now = new Date().toISOString()
  db.query('INSERT OR REPLACE INTO assets (id, mime, size, created_at) VALUES (?, ?, ?, ?)')
    .run(id, mime, buf.length, now)
  return { meta: { id, mime, size: buf.length, created_at: now }, dedup: false }
}

/** 读取元数据 + 磁盘路径；不存在返回 null（磁盘文件缺失视为不存在，并清掉元数据行） */
export function readAsset(id: string): { meta: AssetMeta; path: string } | null {
  if (!/^[0-9a-f]{64}$/.test(id)) return null
  const db = getDb()
  const meta = db.query('SELECT id, mime, size, created_at, remote_url FROM assets WHERE id = ?').get(id) as AssetMeta | undefined
  if (!meta) return null
  const path = join(mediaDir, id)
  if (!existsSync(path)) {
    db.query('DELETE FROM assets WHERE id = ?').run(id)
    return null
  }
  return { meta, path }
}

/** 读取 asset 的外链（无则 null；本地仍为基底，外链是增强层） */
export function getAssetRemoteUrl(id: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(id)) return null
  const row = getDb().query('SELECT remote_url FROM assets WHERE id = ?').get(id) as { remote_url?: string | null } | undefined
  return row?.remote_url || null
}

/**
 * 自动上传模式：异步 spawn 图床命令（fire-and-forget，不阻塞上传响应）。
 * 命令契约：`command [args...] <图片路径>` → stdout 每行一个 http(s) URL。
 * 失败静默降级本地（图片不丢、编辑不受影响），URL 写回 assets.remote_url。
 */
export function maybeUploadToRemote(id: string): void {
  const cfg = uploadConfig
  if (!cfg || cfg.mode !== 'auto' || !cfg.command.trim()) return
  const filePath = join(mediaDir, id)
  if (!existsSync(filePath)) return
  void (async () => {
    try {
      const url = await runUploadCommand(cfg, filePath)
      if (url) {
        getDb().query('UPDATE assets SET remote_url = ? WHERE id = ?').run(url, id)
      }
    } catch {
      // 静默降级：保留本地存储
    }
  })()
}

function runUploadCommand(cfg: ImageUploadConfig, filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      cfg.command,
      [...cfg.args, filePath],
      { timeout: cfg.timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        // 契约：每行一个 URL；只取第一个 http(s) 链接（与 Typora 语义一致）
        const url = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => /^https?:\/\//i.test(l))
        resolve(url ?? null)
      },
    )
  })
}

/** 从 markdown 文本提取 asset:<id> 引用集合 */
export function extractAssetRefs(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/asset:([0-9a-f]{64})/g)) {
    out.add(m[1]!)
  }
  return [...out]
}

/** 全库扫描：返回当前被任意 block 引用的 asset id 集合（引用关系唯一真值） */
export function collectReferencedAssetIds(): Set<string> {
  const db = getDb()
  const rows = db.query("SELECT content FROM blocks WHERE content LIKE '%asset:%'").all() as Array<{ content: string }>
  const refs = new Set<string>()
  for (const r of rows) {
    for (const id of extractAssetRefs(r.content)) refs.add(id)
  }
  return refs
}

/** 校验一组 id 是否都存在；返回缺失列表（写入路径对账用，告警不阻断） */
export function findMissingAssets(ids: string[]): string[] {
  if (ids.length === 0) return []
  const db = getDb()
  const missing: string[] = []
  for (const id of ids) {
    if (!/^[0-9a-f]{64}$/.test(id)) {
      missing.push(id)
      continue
    }
    const row = db.query('SELECT id FROM assets WHERE id = ?').get(id)
    if (!row || !existsSync(join(mediaDir, id))) missing.push(id)
  }
  return missing
}

/**
 * 孤儿回收：删除「无引用 且 上传时间超过宽限期」的 asset（元数据 + 文件）。
 * 返回删除数量与明细。
 */
export function collectOrphanAssets(graceMs: number = ORPHAN_GRACE_MS): { deleted: number; ids: string[] } {
  const db = getDb()
  const referenced = collectReferencedAssetIds()
  const cutoff = new Date(Date.now() - graceMs).toISOString()
  const orphans = db
    .query('SELECT id FROM assets WHERE created_at < ?')
    .all(cutoff) as Array<{ id: string }>
  const deletedIds: string[] = []
  for (const o of orphans) {
    if (referenced.has(o.id)) continue
    db.query('DELETE FROM assets WHERE id = ?').run(o.id)
    try { unlinkSync(join(mediaDir, o.id)) } catch { /* 文件已不存在 */ }
    deletedIds.push(o.id)
  }
  // 顺手清理「磁盘有文件但无元数据」的游离文件（同样受宽限期保护）
  try {
    for (const f of readdirSync(mediaDir)) {
      if (!/^[0-9a-f]{64}$/.test(f)) continue
      const row = db.query('SELECT id FROM assets WHERE id = ?').get(f)
      if (row) continue
      if (Date.now() - statSync(join(mediaDir, f)).mtimeMs < graceMs) continue
      if (referenced.has(f)) continue
      unlinkSync(join(mediaDir, f))
      deletedIds.push(f)
    }
  } catch { /* mediaDir 不可读时跳过 */ }
  return { deleted: deletedIds.length, ids: deletedIds }
}

/** 直接读文件内容（测试与内部用） */
export function readAssetBytes(id: string): Buffer | null {
  const path = join(mediaDir, id)
  if (!existsSync(path)) return null
  return readFileSync(path)
}
