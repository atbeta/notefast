/**
 * Markdown 影子副本：把文档投影到 data/markdown/，给人用访达/资源管理器看见文件。
 *
 * - 路径与归档同构：`<首标签|untagged>/<slug>--<id12>.md`
 * - 单向：改这些 `.md` 不会写回 SQLite
 * - 不复制 media blob；`asset:<sha>` 改写为 `../../media/<sha>`（无扩展名）
 * - 默认开启，可在设置里关掉；关掉后停止写入，已有文件保留
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, rmdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readTags, type BlockRow } from '@notefast/core'
import { readAsset } from '../assets/store'
import { getDb } from '../db'
import { getLiveDocById, listDocRows } from '../store/blocks'
import { archiveRelPath } from '../sync/archive'
import { subscribeDocChanges } from './docEvents'
import { createJsonConfigStore } from './jsonConfig'
import { portableDocMarkdown } from './portableMarkdown'

export const SHADOW_DIR_NAME = 'markdown'
export const SHADOW_MANIFEST_NAME = 'notefast-shadow.manifest.json'
const CONFIG_FILE = 'shadow-markdown.config.json'

export interface ShadowConfig {
  version: 1
  enabled: boolean
}

interface ShadowManifest {
  app: 'notefast'
  kind: 'shadow-markdown'
  version: 1
  updatedAt: string
  files: Array<{ docId: string; filename: string }>
}

function emptyShadowConfig(): ShadowConfig {
  return { version: 1, enabled: true }
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
    return { version: 1, enabled: r.enabled !== false }
  },
})

let dataDirAbs = ''
let unsub: (() => void) | null = null

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
  if (store.get().enabled) {
    try {
      fullSyncShadow()
    } catch (e) {
      console.warn('[shadowMarkdown] fullSync', e instanceof Error ? e.message : e)
    }
  }
}

export function stopShadowMarkdown(): void {
  unsub?.()
  unsub = null
}

export function applyShadowConfig(incoming: { enabled?: boolean }): ShadowConfig {
  const next: ShadowConfig = {
    version: 1,
    enabled: incoming.enabled ?? store.get().enabled,
  }
  const wasEnabled = store.get().enabled
  store.set(next)
  if (next.enabled && !wasEnabled) {
    try {
      fullSyncShadow()
    } catch (e) {
      console.warn('[shadowMarkdown] fullSync', e instanceof Error ? e.message : e)
    }
  }
  return next
}

export function publicInstanceView(): {
  data_dir: string
  markdown_dir: string
  shadow_markdown_enabled: boolean
} {
  return {
    data_dir: getDataDirAbs(),
    markdown_dir: getMarkdownDirAbs(),
    shadow_markdown_enabled: store.get().enabled,
  }
}

/** 把 markdown 中的 asset:<sha> 改写为相对 data/media 的路径（文档固定在 markdown 下一层目录） */
export function rewriteShadowAssetRefs(markdown: string): string {
  return markdown.replace(/asset:([0-9a-f]{64})/g, (full, id: string) => {
    return readAsset(id) ? `../../media/${id}` : full
  })
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

function persistDocFile(doc: BlockRow): string {
  const rel = archiveRelPath(doc.content || 'untitled', doc.id, readTags(doc))
  const dest = join(getMarkdownDirAbs(), rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, rewriteShadowAssetRefs(portableDocMarkdown(doc)), 'utf-8')
  return rel
}

export function writeShadowDoc(doc: BlockRow): void {
  if (!store.get().enabled) return
  const rel = persistDocFile(doc)
  const manifest = loadManifest()
  const prev = manifest.files.find((f) => f.docId === doc.id)
  if (prev && prev.filename !== rel) unlinkRel(prev.filename)
  const files = manifest.files.filter((f) => f.docId !== doc.id)
  files.push({ docId: doc.id, filename: rel })
  saveManifest({ ...manifest, files })
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
  const files: ShadowManifest['files'] = []
  const keep = new Set<string>()
  for (const doc of docs) {
    const rel = persistDocFile(doc)
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
}
