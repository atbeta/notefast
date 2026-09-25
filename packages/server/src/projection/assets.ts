/**
 * 投影文件夹里的附件落盘（RFC 0007 D10）。
 *
 * **为什么必须做**：投影的全部承诺是「这是一个你可以拷走、git 跟踪、用别的编辑器打开的
 * 文件夹」。如果图片留在 `data/media/` 而正文写 `asset:<sha>`，拷走文件夹就是一包碎图——
 * 投影也就白做了。
 *
 * 落点是**笔记同名资源夹** `<笔记名>.assets/`，正文写**相对路径**：
 *   - 每篇一个资源夹而不是共享 `assets/`：删笔记连资源夹一起删，归属清楚，
 *     也不至于让全库图片挤在一个目录里
 *   - 相对路径在任何 Markdown 工具里都能渲染（Obsidian / VSCode / Typora / GitHub），
 *     而 `asset:<sha>` 只有 NoteFast 认识
 *
 * 与 db 模式的边界：**只有建立了投影映射的文档**才走这套；其余文档照旧 `asset:<sha>`
 * 指向 `data/media/`。同一实例里两种文档可以并存。
 */

import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readAsset, readAssetBytes } from '../assets/store'
import { extForMime } from '../sync/archiveMedia'
import { sha256Hex, writeProjectionFileAtomic } from './writer'
import { toProjectionAbsPath } from './paths'
import type { ProjectionConfig } from './config'

/** 资源夹后缀（Obsidian 社区习惯：`<笔记名>.assets/`） */
export const ASSETS_DIR_SUFFIX = '.assets'

/** 一篇笔记的资源夹相对路径；`notes/a.md` → `notes/a.assets` */
export function assetsDirRelFor(relPath: string): string {
  const stem = relPath.replace(/\.(md|markdown)$/i, '')
  return `${stem}${ASSETS_DIR_SUFFIX}`
}

/**
 * asset 在资源夹里的文件名：`<sha 前 16 位><ext>`（内容寻址，天然去重）。
 *
 * 注意 `extForMime` **自带前导点**（`.png`），不要再补一个，否则得到 `..png`。
 */
export function assetFileNameInFolder(assetId: string, mime: string): string {
  return `${assetId.slice(0, 16)}${extForMime(mime)}`
}

export interface MaterializeAssetsResult {
  /** 改写后的 markdown */
  markdown: string
  /** 实际落盘的附件数 */
  written: number
  /** 引用了但库里没有的 asset id */
  missing: string[]
}

/**
 * 把 `asset:<sha>` 引用改写为相对资源夹的路径，并把图片字节落到资源夹。
 *
 * 只处理**建立了投影映射的文档**；db 文档继续走 `asset:<sha>`（见模块头注释）。
 *
 * 返回统计信息：`written` 是本次新落盘的附件数，`missing` 是引用了但库里没有的
 * asset id（悬空引用保留原文，便于排查而不是静默丢图）。
 */
export function materializeAssets(
  markdown: string,
  docRelPath: string,
  config: ProjectionConfig,
): MaterializeAssetsResult {
  const assetsDirRel = assetsDirRelFor(docRelPath)
  const dirName = assetsDirRel.split('/').pop() ?? assetsDirRel
  const missing: string[] = []
  let written = 0

  const out = markdown.replace(/asset:([0-9a-f]{64})/g, (full, id: string) => {
    const found = readAsset(id)
    if (!found) {
      missing.push(id)
      return full
    }
    const bytes = readAssetBytes(id)
    if (!bytes || bytes.length === 0) {
      missing.push(id)
      return full
    }
    const fileName = assetFileNameInFolder(id, found.meta.mime)
    const destAbs = toProjectionAbsPath(config.root, `${assetsDirRel}/${fileName}`)
    if (!existsSync(destAbs)) {
      try {
        mkdirSync(dirname(destAbs), { recursive: true })
        writeFileSync(destAbs, bytes)
        written++
      } catch (e) {
        console.warn('[projection] 附件落盘失败:', e instanceof Error ? e.message : e)
        missing.push(id)
        return full
      }
    }
    return `${dirName}/${fileName}`
  })

  return { markdown: out, written, missing }
}

/**
 * 删除一篇笔记的资源夹（笔记被移除时调用）。
 *
 * 只在资源夹为空或都是我们生成的文件时删——用户可能往里面放过别的东西，
 * 那种情况留给用户自己处置，不静默清空。
 */
export function removeAssetsDir(docRelPath: string, config: ProjectionConfig, maxFiles = 200): void {
  const rel = assetsDirRelFor(docRelPath)
  const abs = toProjectionAbsPath(config.root, rel)
  if (!existsSync(abs)) return
  try {
    // 逐个删我们认识的（`<16位hex>.<ext>`），删空后移除目录
    const entries = readdirSync(abs).slice(0, maxFiles)
    for (const name of entries) {
      if (!/^[0-9a-f]{16}\.[a-z0-9]+$/i.test(name)) continue
      try {
        unlinkSync(join(abs, name))
      } catch {
        /* 已不在 */
      }
    }
    rmdirSync(abs)
  } catch {
    /* 非空（用户自己的文件）或已被删：留给用户 */
  }
}

/** 资源夹内容指纹（用于判断是否需要重写；内容寻址所以只需清单） */
export function assetsDirKey(assetIds: readonly string[]): string {
  return sha256Hex([...assetIds].sort().join(','))
}

/** 供测试与审计用：资源夹是否已存在 */
export function assetsDirExists(docRelPath: string, config: ProjectionConfig): boolean {
  return existsSync(toProjectionAbsPath(config.root, assetsDirRelFor(docRelPath)))
}

/** 与投影文件写入共用同一个原子写原语（避免两套 IO） */
export const writeAttachment = writeProjectionFileAtomic
