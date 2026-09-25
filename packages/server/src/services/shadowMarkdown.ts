/**
 * Markdown 影子副本：把文档投影到 data/markdown/，给人用访达/资源管理器看见文件。
 *
 * - 路径与归档同构：`<首标签|untagged>/<slug>--<id12>.md`
 * - 单向：改这些 `.md` 不会写回 SQLite
 * - 不复制 media blob；`asset:<sha>` 改写为 `../../media/<sha>`（无扩展名）
 * - 默认开启，可在设置里关掉；关掉后停止写入，已有文件保留
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, rmdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  blocksToMarkdown,
  patchFrontmatter,
  readTags,
  stripDocFrontmatter,
  type Block,
  type BlockRow,
} from '@notefast/core'
import { readAsset } from '../assets/store'
import { getDb } from '../db'
import { patchProjectionBody } from '../projection/patch'
import { blockSubtreeHash, recordProjectionSpans, topLevelBlocks } from '../projection/spans'
import { getLiveDocById, listDocRows } from '../store/blocks'
import {
  deleteProjectionBlockSpans,
  listProjectionBlockSpans,
  replaceProjectionBlockSpans,
} from '../store/projectionSpans'
import { archiveRelPath } from '../sync/archive'
import { subscribeDocChanges } from './docEvents'
import { createJsonConfigStore } from './jsonConfig'
import { portableDocMarkdown } from './portableMarkdown'
import { materializeAssets } from '../projection/assets'
import { resolveProjectionConfig, type ProjectionConfig } from '../projection/config'

type ShadowDb = ReturnType<typeof getDb>

export const SHADOW_DIR_NAME = 'markdown'
export const SHADOW_MANIFEST_NAME = 'notefast-shadow.manifest.json'
const CONFIG_FILE = 'shadow-markdown.config.json'

export interface ShadowConfig {
  version: 1
  enabled: boolean
  /**
   * 路径归属。
   *
   * - `system`（默认，现影子副本行为）：路径由 `<首标签|untagged>/<slug>--<id12>.md`
   *   派生，标题 / 标签一变就跟着搬。适合「我只想在访达里看见文件」。
   * - `user`（投影档位，RFC 0007 D2）：首次取默认名，此后**以磁盘实际路径为准**，
   *   用户在外部改名 / 移动不会被下一次投影覆盖。适合「我要用 Obsidian 编辑这些文件」。
   *
   * 默认必须是 `system`：影子副本对既有用户是默认开启的，改成 `user` 会让所有人的
   * 文件同时搬位置。
   */
  pathMode: ShadowPathMode
}

export type ShadowPathMode = 'system' | 'user'

interface ShadowManifest {
  app: 'notefast'
  kind: 'shadow-markdown'
  version: 1
  updatedAt: string
  files: Array<{ docId: string; filename: string }>
}

function emptyShadowConfig(): ShadowConfig {
  return { version: 1, enabled: true, pathMode: 'system' }
}

function emptyManifest(): ShadowManifest {
  return {
    app: 'notefast',
    kind: 'shadow-markdown',
    version: 1,
    updatedAt: new Date().toISOString(),
    files: [],
  }
}

const store = createJsonConfigStore<ShadowConfig>({
  fileName: CONFIG_FILE,
  empty: emptyShadowConfig,
  parse: (raw) => {
    const r = raw as Partial<ShadowConfig>
    if (r.version !== 1) return null
    return {
      version: 1,
      enabled: r.enabled !== false,
      // 未知值退回 system（保守：宁可按系统路径算，也不静默接管用户文件）
      pathMode: r.pathMode === 'user' ? 'user' : 'system',
    }
  },
})

let dataDirAbs = ''
let unsub: (() => void) | null = null
let fullSyncTimer: ReturnType<typeof setTimeout> | null = null
let fullSyncRunning = false
let fullSyncQueued = false
/** 批量导入期间暂停逐篇写盘，结束后由调用方补写新增文档 */
let shadowWritePause = 0

export function initInstancePaths(dir: string): void {
  dataDirAbs = resolve(dir)
}

export function getDataDirAbs(): string {
  return dataDirAbs || resolve(process.env.DATA_DIR || './data')
}

export function getMarkdownDirAbs(): string {
  return join(getDataDirAbs(), SHADOW_DIR_NAME)
}

export function getShadowConfig(): ShadowConfig {
  return store.get()
}

export function initShadowMarkdown(dir: string): void {
  stopShadowMarkdown()
  initInstancePaths(dir)
  store.init(dir)
  unsub = subscribeDocChanges((ev) => {
    if (shadowWritePause > 0) return
    if (!store.get().enabled) return
    try {
      if (ev.kind === 'deleted') {
        removeShadowDoc(ev.doc_id)
        return
      }
      const doc = getLiveDocById(getDb(), ev.doc_id)
      if (doc) writeShadowDoc(doc)
    } catch (e) {
      console.warn('[shadowMarkdown]', e instanceof Error ? e.message : e)
    }
  })
  // 全量投影放到 listen / NF_READY 之后，避免大库卡住启动
  if (store.get().enabled) scheduleFullSyncShadow()
}

export function stopShadowMarkdown(): void {
  cancelScheduledFullSync()
  unsub?.()
  unsub = null
}

function cancelScheduledFullSync(): void {
  if (fullSyncTimer) {
    clearTimeout(fullSyncTimer)
    fullSyncTimer = null
  }
  fullSyncQueued = false
}

function scheduleFullSyncShadow(): void {
  if (!store.get().enabled) return
  if (fullSyncRunning) {
    fullSyncQueued = true
    return
  }
  if (fullSyncTimer) return
  fullSyncTimer = setTimeout(() => {
    fullSyncTimer = null
    runScheduledFullSync()
  }, 0)
  ;(fullSyncTimer as unknown as { unref?: () => void }).unref?.()
}

function runScheduledFullSync(): void {
  if (fullSyncRunning) {
    fullSyncQueued = true
    return
  }
  fullSyncRunning = true
  try {
    fullSyncShadow()
  } catch (e) {
    console.warn('[shadowMarkdown] fullSync', e instanceof Error ? e.message : e)
  } finally {
    fullSyncRunning = false
    if (fullSyncQueued) {
      fullSyncQueued = false
      scheduleFullSyncShadow()
    }
  }
}

export function applyShadowConfig(incoming: { enabled?: boolean; pathMode?: ShadowPathMode }): ShadowConfig {
  const current = store.get()
  const next: ShadowConfig = {
    version: 1,
    enabled: incoming.enabled ?? current.enabled,
    // 必须显式沿用：这里构造的是整份配置，漏掉就会在切换开关时静默重置档位
    pathMode: incoming.pathMode ?? current.pathMode ?? 'system',
  }
  const wasEnabled = current.enabled
  const modeChanged = next.pathMode !== current.pathMode
  store.set(next)
  if (!next.enabled) {
    cancelScheduledFullSync()
  } else if (!wasEnabled || modeChanged) {
    // 档位切换要重算全部路径。
    //
    // 这里有一个必须显式处理的冲突：`user` 档位的「磁盘为准」会让**切换前**那条
    // system 派生的路径（`untagged/标题--<id12>.md`）被当作「用户已定的路径」沿用，
    // 于是永远收敛不到可读名（实测踩过：切了档位，文件名原封不动）。
    //
    // 裁决：切换是一次**显式用户动作**，语义就是「我要求换成可读文件夹」，
    // 因此这一次允许重算路径；但要把旧路径上的内容带过去，
    // 不让用户在外面做的编辑丢失。
    if (modeChanged && next.pathMode === 'user') {
      adoptProjectionPaths()
    }
    scheduleFullSyncShadow()
  }
  return next
}

/**
 * 进入 `user` 档位时把已知路径重算为可读名，内容原样迁移。
 *
 * 只做一次（由 applyShadowConfig 在档位变化时调用）。此后路径以磁盘为准，
 * 用户改名 / 移动都不再被覆盖。
 */
function adoptProjectionPaths(): void {
  const root = getMarkdownDirAbs()
  const manifest = loadManifest()
  const known = new Map(manifest.files.map((f) => [f.docId, f.filename]))
  const adopted: ShadowManifest['files'] = []
  for (const doc of listDocRows(getDb(), { order: 'updated_asc' })) {
    const oldRel = known.get(doc.id) ?? null
    // 已经是「无 id 后缀」形态的路径说明用户已经整理过，不打扰
    const target = projectableRelFor(doc, oldRel)
    if (oldRel && oldRel !== target) {
      try {
        const from = join(root, oldRel)
        const to = join(root, target)
        if (existsSync(from) && !existsSync(to)) {
          mkdirSync(dirname(to), { recursive: true })
          renameSync(from, to)
        }
      } catch {
        /* 迁移失败就留给 fullSync 重写 */
      }
    }
    adopted.push({ docId: doc.id, filename: target })
  }
  saveManifest({ ...emptyManifest(), files: adopted })
}

/** 重算一篇文档的可读投影路径（重名追加 ` (n)`） */
function projectableRelFor(doc: BlockRow, fallbackRel: string | null): string {
  const preferred = `${projectionSlug(doc.content || 'untitled')}.md`
  const root = getMarkdownDirAbs()
  const taken = new Set<string>()
  const manifest = loadManifest()
  for (const f of manifest.files) {
    if (f.docId !== doc.id) taken.add(f.filename)
  }
  // 目标名没被别的文档占用、且磁盘上没有**别的**文件，就直接用它
  if (!taken.has(preferred) && (!existsSync(join(root, preferred)) || preferred === fallbackRel)) {
    return preferred
  }
  const stem = preferred.replace(/\.md$/, '')
  let n = 1
  for (;;) {
    const candidate = `${stem} (${n}).md`
    if (!taken.has(candidate) && (!existsSync(join(root, candidate)) || candidate === fallbackRel)) {
      return candidate
    }
    n++
  }
}

export function publicInstanceView(): {
  data_dir: string
  markdown_dir: string
  shadow_markdown_enabled: boolean
  shadow_path_mode: ShadowPathMode
} {
  return {
    data_dir: getDataDirAbs(),
    markdown_dir: getMarkdownDirAbs(),
    shadow_markdown_enabled: store.get().enabled,
    shadow_path_mode: store.get().pathMode,
  }
}

/**
 * 兜底改写：把 `asset:<sha>` 指向 `data/media/`（**相对**路径，仅在本机同一目录树内可读）。
 *
 * 这是**旧行为**，仍在用于「没有投影映射」的场合。投影文档走
 * `projection/assets.ts` 的 `materializeAssets`——图片落到笔记同名的
 * `<笔记名>.assets/`，正文写相对引用，这样拷走文件夹不会碎图（RFC 0007 D10）。
 */
export function rewriteShadowAssetRefs(markdown: string): string {
  return markdown.replace(/asset:([0-9a-f]{64})/g, (full, id: string) => {
    return readAsset(id) ? `../../media/${id}` : full
  })
}

/**
 * 投影文档的附件改写：图片落资源夹 + 正文写相对引用。
 *
 * 失败时不抛：`materializeAssets` 保留悬空引用的原文，让用户能看见而不是丢图。
 */
function projectAssets(markdown: string, relPath: string): string {
  try {
    return materializeAssets(markdown, relPath, projectionConfig()).markdown
  } catch (e) {
    console.warn('[shadowMarkdown] 附件落盘失败:', e instanceof Error ? e.message : e)
    return rewriteShadowAssetRefs(markdown)
  }
}

/** 投影配置（监听用的字段这里只用到 root / ignore） */
function projectionConfig(): ProjectionConfig {
  return resolveProjectionConfig(getMarkdownDirAbs())
}

function manifestPath(): string {
  return join(getMarkdownDirAbs(), SHADOW_MANIFEST_NAME)
}

function loadManifest(): ShadowManifest {
  const p = manifestPath()
  if (!existsSync(p)) return emptyManifest()
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<ShadowManifest>
    if (raw.app === 'notefast' && raw.kind === 'shadow-markdown' && raw.version === 1 && Array.isArray(raw.files)) {
      return {
        app: 'notefast',
        kind: 'shadow-markdown',
        version: 1,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
        files: raw.files.filter((f): f is { docId: string; filename: string } =>
          Boolean(f && typeof f.docId === 'string' && typeof f.filename === 'string'),
        ),
      }
    }
  } catch {
    /* 损坏当空 */
  }
  return emptyManifest()
}

function saveManifest(manifest: ShadowManifest): void {
  const dir = getMarkdownDirAbs()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const next: ShadowManifest = { ...manifest, updatedAt: new Date().toISOString() }
  writeFileSync(manifestPath(), JSON.stringify(next, null, 2) + '\n', 'utf-8')
}

function unlinkRel(rel: string): void {
  const dest = join(getMarkdownDirAbs(), rel)
  try {
    unlinkSync(dest)
  } catch {
    /* 已不在 */
  }
  try {
    rmdirSync(dirname(dest))
  } catch {
    /* 非空或根目录 */
  }
}

/**
 * 写一篇文档的投影文件。
 *
 * 优先走**按块局部改写**：只重写被编辑的块，其余块复用磁盘旧字节。
 * 拿不到区间记录（首次投影、文档刚被整篇保存过）、区间校验失败时退回整篇序列化。
 *
 * 为什么值得：整篇序列化会把用户的排版交给 mdast 归一化（`_x_` → `*x*`、
 * `$$` → ```math、引用前缀重排），且每次变更都要重算全文。局部改写让
 * 「没动过的块」逐字节保持原样。
 */
function persistDocFile(doc: BlockRow, knownRel: string | null): string {
  const rel = knownRel ?? resolveProjectionRel(doc)
  const dest = join(getMarkdownDirAbs(), rel)
  mkdirSync(dirname(dest), { recursive: true })

  const content = renderShadowContent(doc, dest, rel)
  try {
    if (existsSync(dest) && readFileSync(dest, 'utf-8') === content) return rel
  } catch {
    /* 读失败则重写 */
  }
  writeFileSync(dest, content, 'utf-8')
  return rel
}

/**
 * 决定一篇文档的投影路径。
 *
 * `system` 档位：每次由标题 / 标签派生（现影子副本行为，路径随元数据走）。
 * `user` 档位（RFC 0007 D2）：**首次**取默认名，此后由调用方传入已知路径，
 * 用户在外部改名 / 移动都保留。
 *
 * 这里只负责「首次」这一半：已知路径的判定在 writeShadowDoc 里做，
 * 因为那需要读 manifest。
 */
function resolveProjectionRel(doc: BlockRow): string {
  const mode = store.get().pathMode
  const title = doc.content || 'untitled'
  if (mode === 'user') {
    // 投影档位：文件名不带 id 后缀（那是归档为防重名而加的，用户看会觉得是乱码），
    // 重名由 uniqueProjectionRel 追加 " (n)" 解决
    return uniqueProjectionRel(`${projectionSlug(title)}.md`)
  }
  return archiveRelPath(title, doc.id, readTags(doc))
}

/** 文件名 slug：去路径分隔符与控制字符，保留中文与空格可读性 */
function projectionSlug(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/\.+$/, '')
  return cleaned || 'untitled'
}

/**
 * 重名时追加 ` (n)`（RFC 0007 D2 / RFC 0003 既有规则）。
 * 只在首次落点时计算；已存在的文件由 manifest 记住路径，不走这里。
 */
function uniqueProjectionRel(candidate: string): string {
  const root = getMarkdownDirAbs()
  const stem = candidate.replace(/\.md$/, '')
  let rel = candidate
  let n = 1
  while (existsSync(join(root, rel))) {
    rel = `${stem} (${n}).md`
    n++
  }
  return rel
}

/**
 * 生成投影文件内容：能局部改写就局部改写，否则整篇序列化。
 * 两条路径都会刷新块区间记录，让下一次写回仍可局部化。
 *
 * 区间记录相对的是**去掉首行 H1 标题之后**的正文：投影文件里写着 `# 标题`，
 * 但库里标题是文档根而不是块，不剥掉会让「解析出的顶层块」比「库里的顶层块」
 * 多一个，对齐必然失败（实测踩过：区间表永远是空的，局部改写从不生效）。
 */
function renderShadowContent(doc: BlockRow, dest: string, knownRel: string): string {
  const db = getDb()
  let disk: string | null = null
  try {
    if (existsSync(dest)) disk = readFileSync(dest, 'utf-8')
  } catch {
    disk = null
  }

  if (disk !== null) {
    const oldSpans = listProjectionBlockSpans(db, doc.id)
    if (oldSpans.length > 0) {
      const stripped = stripDocFrontmatter(disk)
      // 偏移口径与 ingest 一致：**只剥 frontmatter，不剥标题行**。
      // 库里那行 H1 是一个真实的 heading 块，必须参与对齐；把它摘出去会让块数
      // 与区间对不上，区间表整体失效、文档永久退回整篇（实测踩过两处：
      // 带图文档 spans=0，以及 writeback.ts 的同名问题）。
      const oldBody = stripped.body
      const tops = topLevelBlocks(db, doc.id)
      const blocks = tops.map((b) => ({ id: b.id, hash: blockSubtreeHash(b), text: serializeBlock(b) }))
      const patched = patchProjectionBody({ oldBody, oldSpans, blocks })
      if (patched) {
        replaceProjectionBlockSpans(db, doc.id, patched.spans)
        // 首行 `# 标题` 在 patch 结果的头部缝隙里，不在块区间内；
        // 在这里按当前标题替换它，否则库里改名后文件标题永远停在旧值
        return withProjectedFrontmatter(disk, replaceRootHeading(patched.body, doc, db), doc, knownRel)
      }
    }
  }

  // 退回整篇序列化：内容由 portableDocMarkdown 生成，随后重建区间记录
  const raw = portableDocMarkdown(doc)
  const full = projectAssets(raw, knownRel)
  // 区间必须相对**库里存的那份内容**（`asset:<sha>`），不是渲染后的文件内容。
  // 用渲染后的正文记录会与 DB 的块对不上（图片引用被改写成了相对路径），
  // 于是区间表永远为空、这类文档永久退回整篇（实测踩过：带图文档 spans=0）。
  const replaced = recordProjectionSpans(db, doc.id, { body: projectionBodyOf(raw) })
  if (!replaced) deleteProjectionBlockSpans(db, doc.id)
  return full
}

/**
 * 取「区间记录所相对的正文」：**只剥 frontmatter**。
 *
 * 不要再剥标题行——库里那行 H1 是真实的 heading 块，剥掉会让解析块数比库里的多，
 * 对齐必然失败、区间表永远为空（实测踩过三次：带图文档、writeback.ts、这里）。
 * 出方向与本函数的口径必须完全一致。
 */
function projectionBodyOf(content: string): string {
  return stripDocFrontmatter(content).body
}

/**
 * 正文首行是不是「文档根标题」那一行（库里**没有**对应块的那一行）。
 *
 * 判据是「首行是 H1 **且** 库里的首个顶层块不是同内容的 heading」——
 * **不能**用「首行 H1 与当前标题同文」：渲染侧手里是**磁盘旧内容 + 当前标题**，
 * 一旦在库里改了名，两者必然不同，判据就会失效、文件标题永远停在旧值（实测踩过）。
 *
 * 为什么要区分：用户完全可以自己写一个与标题不同的 H1（`# 旧名`，标题是文件名）。
 * 那一行在库里有对应的 heading 块，是**用户内容**，必须原样往返，不能被覆盖。
 *
 * 与 `spans.ts` 的判据等价（那边是解析结果与库里逐块比对，同一次快照，天然自洽）。
 */
function isRootHeadingLine(body: string, db: ShadowDb, docId: string): boolean {
  if (!body) return false
  const nl = body.indexOf('\n')
  const firstLine = (nl < 0 ? body : body.slice(0, nl)).trim()
  if (!/^#\s+\S/.test(firstLine)) return false
  const firstBlock = topLevelBlocks(db, docId)[0]
  if (!firstBlock || firstBlock.type !== 'heading') return true
  const headingText = firstLine.replace(/^#\s*/, '').trim()
  return (firstBlock.content ?? '').trim() !== headingText
}

/**
 * 把正文首行的「文档根标题」替换为当前标题（不改变后续偏移）。
 * 只在首行确实是根标题时替换；用户自己写的别的 H1 不动。
 */
function replaceRootHeading(body: string, doc: BlockRow, db: ShadowDb): string {
  if (!isRootHeadingLine(body, db, doc.id)) return body
  const nl = body.indexOf('\n')
  const rest = nl < 0 ? '' : body.slice(nl + 1)
  return titleHeadingOf(doc) + rest
}

function titleHeadingOf(doc: BlockRow): string {
  const title = (doc.content || '').trim()
  return title ? `# ${title}\n` : ''
}

/**
 * 保留磁盘上用户手写的 frontmatter，只把 NoteFast 的 tags 投影进去。
 *
 * tags 为空时**不动** frontmatter：`patchFrontmatter` 把空数组视为「删除该键」，
 * 而整篇序列化路径写的是 `tags: []`。两条路径必须产出同一份内容，
 * 否则「内容未变时 fullSync 不重写文件」会退化——每次同步都认为内容变了。
 */
function withProjectedFrontmatter(
  disk: string,
  body: string,
  doc: BlockRow,
  knownRel: string | null,
): string {
  const stripped = stripDocFrontmatter(disk)
  const tags = readTags(doc)
  const frontmatterRaw =
    tags.length === 0 && stripped.raw === null
      ? null
      : patchFrontmatter(stripped.raw, tags.length === 0 ? {} : { tags })
  const fm = frontmatterRaw ? `---\n${frontmatterRaw}\n---\n` : ''
  const content = fm + body
  // 投影文档：附件落资源夹；没有映射的场合保持旧行为
  return knownRel ? projectAssets(content, knownRel) : rewriteShadowAssetRefs(content)
}


/** 单个顶层块的 Markdown 序列化（与整篇路径同一函数，保证口径一致） */
function serializeBlock(block: Block): string {
  return blocksToMarkdown([block])
}

/** 批量导入：暂停影子副本的逐篇写盘（可嵌套） */
export function pauseShadowWrites(): void {
  shadowWritePause++
}

export function resumeShadowWrites(): void {
  if (shadowWritePause > 0) shadowWritePause--
}

export function writeShadowDoc(doc: BlockRow): void {
  if (!store.get().enabled) return
  const manifest = loadManifest()
  const prev = manifest.files.find((f) => f.docId === doc.id)
  const rel = persistDocFile(doc, knownRelFor(prev?.filename ?? null))
  if (prev?.filename === rel) return
  // 路径变了才删旧文件。
  // `user` 档位下不会走到这里（已知路径被沿用），因此用户在外部改名不会被这里清掉。
  if (prev) unlinkRel(prev.filename)
  const files = manifest.files.filter((f) => f.docId !== doc.id)
  files.push({ docId: doc.id, filename: rel })
  saveManifest({ ...manifest, files })
}

/**
 * 已知路径的判定（RFC 0007 D2「以磁盘为准」）。
 *
 * `user` 档位下，只要映射里记着路径且**该文件确实存在**，就继续用它——
 * 哪怕文档标题 / 标签已经变了。用户自己改的名、挪的目录都因此保留。
 *
 * 文件不在了（被外部删除）则返回 null：下次投影按标题重新落一个默认名。
 * 这是「文件被删 → 库侧进回收站」之外的一条兜底：删除是 D9 的入方向职责，
 * 这里只保证不会把路径钉死在一个已经不存在的文件上。
 */
function knownRelFor(mappedRel: string | null): string | null {
  if (store.get().pathMode !== 'user') return null
  if (!mappedRel) return null
  try {
    if (!existsSync(join(getMarkdownDirAbs(), mappedRel))) return null
  } catch {
    return null
  }
  return mappedRel
}

export function removeShadowDoc(docId: string): void {
  const manifest = loadManifest()
  const prev = manifest.files.find((f) => f.docId === docId)
  if (!prev) return
  unlinkRel(prev.filename)
  saveManifest({ ...manifest, files: manifest.files.filter((f) => f.docId !== docId) })
}

export function fullSyncShadow(): void {
  if (!store.get().enabled) return
  const docs = listDocRows(getDb(), { order: 'updated_asc' })
  const prev = loadManifest()
  const known = new Map(prev.files.map((f) => [f.docId, f.filename]))
  const files: ShadowManifest['files'] = []
  const keep = new Set<string>()
  for (const doc of docs) {
    const rel = persistDocFile(doc, knownRelFor(known.get(doc.id) ?? null))
    files.push({ docId: doc.id, filename: rel })
    keep.add(rel)
  }
  for (const f of prev.files) {
    if (!keep.has(f.filename)) unlinkRel(f.filename)
  }
  saveManifest({ ...emptyManifest(), files })
}

export function _resetShadowMarkdownForTests(): void {
  stopShadowMarkdown()
  store._resetForTests()
  dataDirAbs = ''
  shadowWritePause = 0
}
