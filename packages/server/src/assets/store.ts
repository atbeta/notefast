/**
 * AssetStore — 图片唯一主数据源
 *
 * 设计（与 AGENTS.md 一致）：
 * - 内容寻址：asset id = 内容 sha256。同一图片重复上传 = 同一 id，天然去重幂等
 * - 文件落盘 data/media/<id>，SQLite 只存元数据（assets 表），不存 BLOB
 * - 引用关系不建关联表：真值在 markdown 内容里（asset:<id>），用 SQL LIKE 扫描推导，
 *   无对账代码、无漂移可能
 * - 孤儿回收：引用扫描 + 宽限期，手动触发（POST /assets/gc）
 * - 显式删除：DELETE /assets/:id，仅允许当前无引用的资源（无宽限期，用户确认即删）
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { getDb } from '../db'
import { getChangesAnchor, contentRevisionToken } from '../store/changeFeed'
import type { ImageUploadConfig } from '@notefast/core'
import { extForMime, mimeForExt } from '../sync/archiveMedia'

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
  /** 原始文件名（上传/导入时保存；存量可空，资源页回退显示哈希短前缀） */
  filename?: string | null
}

/** 当前生效的图床上传配置（initImageUploadConfig 后由 app 注入） */
let uploadConfig: ImageUploadConfig | null = null

export function setImageUploadConfig(cfg: ImageUploadConfig | null): void {
  uploadConfig = cfg
}

/** 保存图片（幂等去重）；返回元数据。dedup=true 表示命中已有内容未重复写盘 */
export function saveAsset(buf: Buffer, mime: string, filename?: string | null): { meta: AssetMeta; dedup: boolean } {
  const id = createHash('sha256').update(buf).digest('hex')
  const db = getDb()
  const existing = db.query('SELECT id, mime, size, created_at, filename FROM assets WHERE id = ?').get(id) as AssetMeta | undefined
  if (existing && existsSync(join(mediaDir, id))) {
    return { meta: existing, dedup: true }
  }
  writeFileSync(join(mediaDir, id), buf)
  const now = new Date().toISOString()
  // 内容寻址去重：同图再次写入时补 filename（首次没带、这次带了）
  if (existing && !existing.filename && filename) {
    db.query('UPDATE assets SET filename = ? WHERE id = ?').run(filename, id)
    return { meta: { ...existing, filename }, dedup: true }
  }
  db.query('INSERT OR REPLACE INTO assets (id, mime, size, created_at, filename) VALUES (?, ?, ?, ?, ?)')
    .run(id, mime, buf.length, now, filename ?? null)
  return { meta: { id, mime, size: buf.length, created_at: now, filename: filename ?? null }, dedup: false }
}

/** 读取元数据 + 磁盘路径；不存在返回 null（磁盘文件缺失视为不存在，并清掉元数据行） */
export function readAsset(id: string): { meta: AssetMeta; path: string } | null {
  if (!/^[0-9a-f]{64}$/.test(id)) return null
  const db = getDb()
  const meta = db.query('SELECT id, mime, size, created_at, remote_url, filename FROM assets WHERE id = ?').get(id) as AssetMeta | undefined
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

/** 全库扫描：返回当前被任意 block 引用的 asset id 集合（引用关系唯一真值）。
 *  带缓存：key = 变更流全局锚点 + 内容修订计数（runFeedSuppressed 的消费/清理
 *  写路径也推进计数）——正常写操作推进 seq 锚点失效，同步消费推进计数失效，
 *  无写时零成本复用（与 sharePublic 的文档级缓存同方案） */
let referencedAssetCache: { key: string; refs: Set<string> } | null = null

export function collectReferencedAssetIds(): Set<string> {
  const db = getDb()
  const key = `${getChangesAnchor(db)}:${contentRevisionToken()}`
  if (referencedAssetCache?.key === key) return referencedAssetCache.refs
  const rows = db.query("SELECT content FROM blocks WHERE content LIKE '%asset:%'").all() as Array<{ content: string }>
  const refs = new Set<string>()
  for (const r of rows) {
    for (const id of extractAssetRefs(r.content)) refs.add(id)
  }
  referencedAssetCache = { key, refs }
  return refs
}

/** assetId → 引用它的文档（doc_id + title）映射；同 key 缓存复用扫描结果 */
let refMapCache: { key: string; map: Map<string, Array<{ doc_id: string; title: string }>> } | null = null

function assetRefMapKey(db: ReturnType<typeof getDb>): string {
  return `${getChangesAnchor(db)}:${contentRevisionToken()}`
}

/**
 * 全库扫描：返回 asset id → 引用它的文档列表（排除软删除文档）。
 * 一次 SQL 拉含 asset: 的块，按 root_id 聚合到文档根取 title。
 * 与 collectReferencedAssetIds 共用变更流锚点缓存，无写时零成本复用。
 */
function collectAssetRefMap(): Map<string, Array<{ doc_id: string; title: string }>> {
  const db = getDb()
  const key = assetRefMapKey(db)
  if (refMapCache?.key === key) return refMapCache.map
  const rows = db
    .query(
      `SELECT b.root_id, b.content, d.content AS doc_title
       FROM blocks b
       JOIN blocks d ON d.id = b.root_id AND d.type = 'document' AND d.is_deleted = 0
       WHERE b.content LIKE '%asset:%' AND b.is_deleted = 0`,
    )
    .all() as Array<{ root_id: string; content: string; doc_title: string }>
  const map = new Map<string, Array<{ doc_id: string; title: string }>>()
  for (const r of rows) {
    for (const id of extractAssetRefs(r.content)) {
      let arr = map.get(id)
      if (!arr) {
        arr = []
        map.set(id, arr)
      }
      if (!arr.some((x) => x.doc_id === r.root_id)) {
        arr.push({ doc_id: r.root_id, title: r.doc_title })
      }
    }
  }
  refMapCache = { key, map }
  return map
}

/** 引用某 asset 的文档列表（按创建序稳定）；未引用返回空数组 */
export function findReferencingDocs(assetId: string): Array<{ doc_id: string; title: string }> {
  return collectAssetRefMap().get(assetId) ?? []
}

export interface AssetListItem {
  id: string
  mime: string
  size: number
  created_at: string
  /** 原始文件名（可空：存量/无法获取；前端回退显示哈希短前缀） */
  filename: string | null
  /** 本地文件路径（相对 data 目录，如 media/<id>；供「复制路径」/定位用） */
  local_path: string
  /** 是否已挂图床外链 */
  remote: boolean
  /** 图床外链地址（remote 时非空；供资源页悬浮展示/复制） */
  remote_url: string | null
  /** 是否被任意未删除文档引用 */
  referenced: boolean
  /** 引用该图片的文档数（>1 说明多篇复用同一张图） */
  ref_count: number
}

/**
 * 资源库列表（按创建时间倒序）。
 * referenced / ref_count 来自内容扫描，不建关联表。
 */
export function listAssets(opts: { limit?: number; offset?: number } = {}): {
  items: AssetListItem[]
  total: number
} {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)
  const db = getDb()
  const totalRow = db.query('SELECT COUNT(*) AS n FROM assets').get() as { n: number }
  const total = totalRow?.n ?? 0
  const rows = db
    .query(
      `SELECT id, mime, size, created_at, remote_url, filename
       FROM assets
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as Array<{
    id: string
    mime: string
    size: number
    created_at: string
    remote_url: string | null
    filename: string | null
  }>
  const refMap = rows.length > 0 ? collectAssetRefMap() : null
  return {
    total,
    items: rows.map((r) => {
      const refs = refMap?.get(r.id)
      return {
        id: r.id,
        mime: r.mime,
        size: r.size,
        created_at: r.created_at,
        filename: r.filename,
        local_path: `media/${r.id}`,
        remote: Boolean(r.remote_url),
        remote_url: r.remote_url,
        referenced: Boolean(refs && refs.length > 0),
        ref_count: refs?.length ?? 0,
      }
    }),
  }
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

export type DeleteAssetResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'in_use' }

/**
 * 显式删除单个资源：仅当当前无任何 block 引用时允许（含软删文档内引用，恢复后仍要可用）。
 * 与 GC 不同：无宽限期——用户在资源库确认删除即执行。
 */
export function deleteAsset(id: string): DeleteAssetResult {
  if (!/^[0-9a-f]{64}$/.test(id)) return { ok: false, reason: 'not_found' }
  if (!readAsset(id)) return { ok: false, reason: 'not_found' }
  if (collectReferencedAssetIds().has(id)) return { ok: false, reason: 'in_use' }
  getDb().query('DELETE FROM assets WHERE id = ?').run(id)
  try {
    unlinkSync(join(mediaDir, id))
  } catch {
    /* 文件已不存在 */
  }
  return { ok: true }
}

export interface IngestLocalImagesResult {
  /** 重写后的 markdown（相对路径 → asset:<sha>） */
  markdown: string
  /** 成功入库的图片数 */
  ingested: number
  /** 找不到/非图片而未处理的引用（保持原样） */
  unresolved: string[]
}

const LOCAL_IMG_REF_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

/**
 * 打开/导入本地 markdown 时收编相对路径图片：md 里 `![](images/foo.png)`
 * 这类引用在 NoteFast 语义里没有根（图片模型只有 asset: 与绝对 URL），
 * 渲染必然碎图。此函数把「相对路径引用 → 解析为本地文件 → 内容寻址入库 →
 * 引用重写为 asset:<sha>」。
 *
 * readCandidate 由调用方提供（file-open 读同目录 / zip 读 entries），
 * 返回文件字节或 null（不存在/非图片）。返回重写后的 markdown 与统计。
 */
export function ingestLocalImageRefs(
  markdown: string,
  readCandidate: (relPath: string) => Buffer | null,
): IngestLocalImagesResult {
  let out = markdown
  let ingested = 0
  const unresolved = new Set<string>()
  const used = new Set<string>() // 同路径多次引用只处理一次
  out = out.replace(LOCAL_IMG_REF_RE, (full, _alt: string, rawSrc: string) => {
    // 只处理相对路径：asset:/http(s)/data: 等已有语义的引用不动
    if (
      rawSrc.startsWith('asset:') ||
      rawSrc.startsWith('http:') ||
      rawSrc.startsWith('https:') ||
      rawSrc.startsWith('data:') ||
      rawSrc.startsWith('/') // 绝对路径：无 vault 根，跳过
    ) {
      return full
    }
    // 去 query/hash（`foo.png?v=2`）；%20 等 URL 编码还原
    const clean = rawSrc.split(/[?#]/)[0]!.trim()
    const decoded = decodeURIComponent(clean).replace(/\\/g, '/')
    if (!decoded || used.has(decoded)) return full
    const buf = readCandidate(decoded)
    if (!buf || buf.length === 0) {
      unresolved.add(decoded)
      return full
    }
    const ext = decoded.split('.').pop()?.toLowerCase() ?? ''
    const mime = mimeForExt(ext)
    if (!mime?.startsWith('image/')) {
      unresolved.add(decoded)
      return full
    }
    const { meta } = saveAsset(buf, mime, decoded)
    used.add(decoded)
    ingested++
    return full.replace(rawSrc, `asset:${meta.id}`)
  })
  return { markdown: out, ingested, unresolved: [...unresolved] }
}

/**
 * file-open 场景的 readCandidate：相对引用按「md 文件同目录」解析。
 * 只读普通文件、图片扩展名由 ingestLocalImageRefs 二次把关。
 * 目录归属用 path.relative 判断（跨平台；Windows 反斜杠路径不能 startsWith 正斜杠前缀）。
 */
export function readLocalImageCandidate(mdPath: string): (relPath: string) => Buffer | null {
  const baseDir = dirname(mdPath)
  return (relPath: string) => {
    try {
      const abs = resolve(baseDir, relPath)
      // 防路径穿越读取任意文件：只允许 md 同目录树内
      const rel = relative(baseDir, abs)
      if (rel === '..' || rel.startsWith('..' + '/') || rel.startsWith('..' + '\\') || isAbsolute(rel)) return null
      if (!existsSync(abs)) return null
      const st = statSync(abs)
      if (!st.isFile()) return null
      return readFileSync(abs)
    } catch {
      return null
    }
  }
}

/**
 * web 上传场景（multipart /import/markdown-files）的 readCandidate：
 * 从「相对路径 → 文件字节」映射构建。Web 导入 tab 已不再走多选/拖文件夹；
 * 此函数仍服务该 API 与测试。匹配时先精确相对路径，再退回 basename。
 */
export function readUploadedImageCandidate(files: Array<{ path: string; data: Buffer }>): (relPath: string) => Buffer | null {
  const byPath = new Map<string, Buffer>()
  const byBase = new Map<string, Buffer>()
  for (const f of files) {
    const norm = f.path.replace(/\\/g, '/').replace(/^\.\//, '')
    byPath.set(norm, f.data)
    const base = norm.split('/').pop() ?? norm
    if (base && !byBase.has(base)) byBase.set(base, f.data)
  }
  return (relPath: string) => {
    const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
    const hit = byPath.get(norm)
    if (hit) return hit
    const base = norm.split('/').pop() ?? norm
    return byBase.get(base) ?? null
  }
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
