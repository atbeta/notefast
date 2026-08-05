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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from '../db'
import type { ImageUploadConfig } from '@notefast/core'
import { extForMime } from '../sync/archiveMedia'

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

/** 批量查询上传状态（渲染层单图徽章用）：id → { remote, error } */
export function getAssetUploadStatus(ids: string[]): Record<string, { remote: boolean; error: string | null }> {
  const out: Record<string, { remote: boolean; error: string | null }> = {}
  if (ids.length === 0) return out
  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.query(
    `SELECT id, remote_url, upload_error FROM assets WHERE id IN (${placeholders})`,
  ).all(...ids) as Array<{ id: string; remote_url: string | null; upload_error: string | null }>
  for (const r of rows) {
    out[r.id] = { remote: Boolean(r.remote_url), error: r.upload_error }
  }
  return out
}

/**
 * 单图触发上传（同步等待结果，供 hover 徽章点击用）。
 * 返回结果并写回 assets 表；未启用自动上传 / 命令为空时返回错误。
 */
export async function uploadSingleAsset(id: string): Promise<UploadCommandOutcome> {
  const cfg = uploadConfig
  if (!cfg || cfg.mode !== 'auto' || !cfg.command.trim()) {
    return { ok: false, error: '未启用自动上传或命令为空（设置 → 图床与图片）' }
  }
  const srcPath = join(mediaDir, id)
  if (!existsSync(srcPath)) {
    return { ok: false, error: '本地文件缺失' }
  }
  const outcome = await runUploadCommandForAsset(cfg, id, srcPath)
  applyUploadOutcome(id, outcome)
  return outcome
}

/**
 * 自动上传模式：异步 spawn 图床命令（fire-and-forget，不阻塞上传响应）。
 * 命令契约：`command [args...] <图片路径>` → stdout 每行一个 http(s) URL。
 * 失败记录 upload_error（设置页可查），不丢图、不影响编辑。
 */
export function maybeUploadToRemote(id: string): void {
  const cfg = uploadConfig
  if (!cfg || cfg.mode !== 'auto' || !cfg.command.trim()) return
  const srcPath = join(mediaDir, id)
  if (!existsSync(srcPath)) return
  void (async () => {
    const outcome = await runUploadCommandForAsset(cfg, id, srcPath)
    applyUploadOutcome(id, outcome)
  })()
}

/** 写回上传结果：成功清 error 写 remote_url；失败记 upload_error。两者都刷新 upload_attempted_at */
function applyUploadOutcome(id: string, outcome: UploadCommandOutcome): void {
  const db = getDb()
  const now = new Date().toISOString()
  if (outcome.ok && outcome.url) {
    db.query('UPDATE assets SET remote_url = ?, upload_error = NULL, upload_attempted_at = ? WHERE id = ?')
      .run(outcome.url, now, id)
  } else {
    db.query('UPDATE assets SET upload_error = ?, upload_attempted_at = ? WHERE id = ?')
      .run(outcome.error ?? 'unknown error', now, id)
  }
}

/**
 * 图床命令需要带扩展名的文件路径（picfast 等按扩展名判文件类型，
 * media/<sha256> 无扩展名会被 400 拒收）——在 tmpdir 建 <id>.<ext> 副本再跑命令。
 */
async function runUploadCommandForAsset(
  cfg: ImageUploadConfig,
  id: string,
  srcPath: string,
): Promise<UploadCommandOutcome> {
  const row = getDb().query('SELECT mime FROM assets WHERE id = ?').get(id) as { mime: string } | undefined
  const ext = row ? extForMime(row.mime) : '.bin'
  const tmpFile = join(tmpdir(), `notefast-upload-${id}${ext}`)
  try {
    copyFileSync(srcPath, tmpFile)
    return await runUploadCommand(cfg, tmpFile)
  } finally {
    try { unlinkSync(tmpFile) } catch { /* ignore */ }
  }
}

// ───────────────────── 存量图片批量补传 ─────────────────────

export interface UploadBatchStatus {
  running: boolean
  total: number
  done: number
  ok: number
  failed: number
  lastError: string | null
}

let batchStatus: UploadBatchStatus = { running: false, total: 0, done: 0, ok: 0, failed: 0, lastError: null }

/** 批量补传进度（内存态；结果已持久化到 assets 表，重启后进度归零不影响事实） */
export function getUploadBatchStatus(): UploadBatchStatus {
  return { ...batchStatus }
}

/**
 * 存量图片补传：remote_url IS NULL 的全部 assets 串行上传（避免打爆图床）。
 * 已在跑则返回 running。返回排队数量。
 */
export function uploadMissingAssets(): { queued: number; running: boolean } {
  if (batchStatus.running) return { queued: 0, running: true }
  const cfg = uploadConfig
  if (!cfg || cfg.mode !== 'auto' || !cfg.command.trim()) return { queued: 0, running: false }
  const ids = (getDb().query('SELECT id FROM assets WHERE remote_url IS NULL').all() as Array<{ id: string }>)
    .map((r) => r.id)
  if (ids.length === 0) return { queued: 0, running: false }
  batchStatus = { running: true, total: ids.length, done: 0, ok: 0, failed: 0, lastError: null }
  void (async () => {
    for (const id of ids) {
      const srcPath = join(mediaDir, id)
      let outcome: UploadCommandOutcome
      if (!existsSync(srcPath)) {
        outcome = { ok: false, error: '本地文件缺失' }
      } else {
        outcome = await runUploadCommandForAsset(cfg, id, srcPath)
      }
      applyUploadOutcome(id, outcome)
      batchStatus.done++
      if (outcome.ok && outcome.url) batchStatus.ok++
      else {
        batchStatus.failed++
        batchStatus.lastError = outcome.error ?? null
      }
    }
    batchStatus.running = false
  })()
  return { queued: ids.length, running: true }
}

/**
 * 图床命令容错：command 字段允许用户直接填「完整命令」（如 `D:\\Tools\\picfast.exe upload`），
 * 按 shell 引号感知分词拆成可执行文件 + 前置参数（Windows 路径本身可含空格，用引号包裹）。
 */
export function splitUploadCommand(input: string): { command: string; preArgs: string[] } {
  const trimmed = input.trim()
  if (!trimmed) return { command: '', preArgs: [] }
  const parts: string[] = []
  let cur = ''
  let inQuote = false
  for (const ch of trimmed) {
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (ch === ' ' && !inQuote) {
      if (cur) {
        parts.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur) parts.push(cur)
  if (parts.length === 0) return { command: '', preArgs: [] }
  return { command: parts[0]!, preArgs: parts.slice(1) }
}

export interface UploadCommandOutcome {
  ok: boolean
  url?: string
  /** 失败原因（供 upload_error 列 / 测试端点展示） */
  error?: string
  stdout?: string
  stderr?: string
  exitCode?: number | null
}

/**
 * 执行一次图床命令（测试端点与自动上传共用）。
 * 契约：command [args...] <图片路径> → stdout 每行一个 http(s) URL。
 */
export function runUploadCommand(cfg: ImageUploadConfig, filePath: string): Promise<UploadCommandOutcome> {
  const { command, preArgs } = splitUploadCommand(cfg.command)
  if (!command) {
    return Promise.resolve({ ok: false, error: '上传命令为空' })
  }
  return new Promise((resolve) => {
    execFile(
      command,
      [...preArgs, ...cfg.args, filePath],
      { timeout: cfg.timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '')
        const errText = String(stderr ?? '')
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: string | number }).code
          const reason = typeof code === 'string'
            ? `${command}: ${code}${errText ? ` · ${errText.trim().slice(0, 200)}` : ''}`
            : `${command}: ${errText.trim().slice(0, 200) || err.message}`
          return resolve({ ok: false, error: reason, stdout: out, stderr: errText, exitCode: typeof code === 'number' ? code : null })
        }
        const url = out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => /^https?:\/\//i.test(l))
        if (!url) {
          return resolve({
            ok: false,
            error: `命令成功退出但 stdout 无 http(s) URL${errText ? ` · ${errText.trim().slice(0, 200)}` : ''}`,
            stdout: out,
            stderr: errText,
            exitCode: 0,
          })
        }
        resolve({ ok: true, url, stdout: out, stderr: errText, exitCode: 0 })
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
