/**
 * vault 模式下的图片落盘（RFC 0006 / U-13）
 *
 * 约定：图片放在**笔记同名的资源夹** `<笔记名>.assets/`，正文用相对路径引用
 * （`![](a.assets/pic.png)`）。
 *
 * 为什么每篇一个资源夹、而不是全库共用一个 `assets/`：
 * - 共用一个目录会让整个库的图片挤在一起，归属不清（这张图是谁的？删笔记时该删哪张？）
 * - 每篇一个：删笔记连它的资源夹一起删；相对引用在任何 Markdown 工具里都能打开
 *
 * 为什么不能继续用 `asset:<sha256>`：那个引用只有 NoteFast 认（图片存在索引目录 `data/media/`），
 * 在 Obsidian / Typora / GitHub 里是碎图，复制走文件夹也带不走图片——直接违背
 * 「文件夹是权威、我的文件我能拿走」。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { toVaultAbsPath } from './paths'

/** 资源夹后缀：`笔记.md` → `笔记.assets/` */
export const ASSET_DIR_SUFFIX = '.assets'

/** 笔记的 vault 相对路径 → 它的资源夹（相对 vault 根） */
export function noteAssetDirRelPath(noteRelPath: string): string {
  const dir = posix.dirname(noteRelPath)
  const base = posix.basename(noteRelPath).replace(/\.md$/i, '')
  const folder = `${base}${ASSET_DIR_SUFFIX}`
  return dir === '.' || dir === '' ? folder : posix.join(dir, folder)
}

/**
 * 文件名清洗：去掉路径分隔与控制字符，只保留可读名字。
 * 空 / 全非法 → `image.<ext>`。
 */
function safeFileName(name: string | null, ext: string): string {
  const raw = (name ?? '').trim().replace(/\.[a-z0-9]+$/i, '')
  const cleaned = Array.from(raw)
    .map((ch) => (ch.charCodeAt(0) < 0x20 || /[\\/:*?"<>|]/.test(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 80)
  return `${cleaned || 'image'}${ext}`
}

function extFromMime(mime: string): string {
  const sub = mime.split('/')[1]?.toLowerCase() ?? ''
  if (sub === 'jpeg' || sub === 'jpg') return '.jpg'
  if (sub === 'svg+xml') return '.svg'
  if (sub === 'x-icon') return '.ico'
  if (sub === 'quicktime') return '.mov'
  return sub ? `.${sub.replace(/[^a-z0-9]/g, '')}` : '.bin'
}

export interface WriteVaultImageInput {
  /** vault 根绝对路径 */
  root: string
  /** 目标笔记的 vault 相对路径（`notes/a.md`） */
  noteRelPath: string
  /** 原始文件名（可空） */
  fileName: string | null
  /** 图片 mime（决定扩展名） */
  mime: string
  bytes: Uint8Array
}

export interface WriteVaultImageResult {
  /** vault 相对路径（`notes/a.assets/pic.png`） */
  relPath: string
  /** 正文里该插入的引用：相对笔记所在目录（`a.assets/pic.png`），Obsidian 等工具直接可读 */
  ref: string
}

/**
 * 把图片写进笔记的资源夹；重名自动加 `-2` / `-3`（不覆盖已有文件）。
 * 路径越界交给 `toVaultAbsPath` 抛错（调用方退回流处理）。
 */
export function writeVaultImage(input: WriteVaultImageInput): WriteVaultImageResult {
  const dirRel = noteAssetDirRelPath(input.noteRelPath)
  const ext = extFromMime(input.mime)
  const safe = safeFileName(input.fileName, ext)
  const stem = safe.slice(0, safe.length - ext.length)

  let candidate = posix.join(dirRel, safe)
  let n = 1
  while (existsSync(join(input.root, candidate))) {
    n += 1
    candidate = posix.join(dirRel, `${stem}-${n}${ext}`)
  }

  const abs = toVaultAbsPath(input.root, candidate)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, input.bytes)

  // 引用相对**笔记所在目录**：根目录下的笔记，candidate 自身就是要插进正文的路径
  // （取 basename 会丢掉 `a.assets/`，正文变成 ![](image.png) → 碎图）
  const noteDir = posix.dirname(input.noteRelPath)
  const ref = noteDir === '.' || noteDir === '' ? candidate : posix.relative(noteDir, candidate)
  return { relPath: candidate, ref }
}
