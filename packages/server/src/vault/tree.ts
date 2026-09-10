/**
 * vault 目录树（RFC 0005 M7 / U-8）：把扁平的文件清单聚合成可按层拉取的树。
 *
 * 为什么要有这个端点：vault 的目录是用户自己组织的，而 `/vault/files` 返回的是
 * 全部行（10k 文件不可能全给前端建树）。这里只做**一层**聚合，前端点开目录再拉下一层。
 *
 * 纯函数 + 入参是 rel_path 列表，便于单测；DB 读取留在路由层。
 */

import { isIgnoredRelPath, isMarkdownPath } from './paths'

export interface VaultTreeDir {
  /** 目录相对路径（无尾斜杠），根目录下第一层如 `notes/books` */
  path: string
  /** 显示名（路径最后一段） */
  name: string
  /** 该目录下**直接**的 .md 数 */
  files: number
  /** 该目录及其子目录下的 .md 总数 */
  total: number
}

export interface VaultTreeFile {
  path: string
  /** 显示名（文件名去掉 .md；vault 约定标题 = 文件名） */
  name: string
  doc_id: string
}

export interface VaultTreeLevel {
  /** 本层所在的目录（'' = 根） */
  path: string
  dirs: VaultTreeDir[]
  files: VaultTreeFile[]
}

/** 树条目：路由层从 `vault_files` 映射而来（只含未删除的行） */
export interface VaultTreeEntry {
  relPath: string
  docId: string
}

function parentOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx < 0 ? '' : relPath.slice(0, idx)
}

function baseName(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  const name = idx < 0 ? relPath : relPath.slice(idx + 1)
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name
}

/** 目录名（路径最后一段） */
function dirName(dirPath: string): string {
  const idx = dirPath.lastIndexOf('/')
  return idx < 0 ? dirPath : dirPath.slice(idx + 1)
}

/**
 * 聚合出 `dirPath` 这一层。
 *
 * - `ignore`：默认忽略规则（`.trash` / `.obsidian` / 隐藏目录等），忽略的目录整棵不出现
 * - 只统计 `.md`；附件（图片等）不进树，避免把附件目录混进笔记结构
 */
export function buildVaultTree(
  entries: readonly VaultTreeEntry[],
  opts: { path?: string; ignore?: readonly string[] } = {},
): VaultTreeLevel {
  const dirPath = (opts.path ?? '').replace(/^\/+|\/+$/g, '')
  const ignore = opts.ignore ?? []
  const prefix = dirPath === '' ? '' : `${dirPath}/`

  /** 每个目录下**直接**的 .md 数（不只本层，供子目录显示自己的数量） */
  const directCount = new Map<string, number>()
  /** 每个目录及其子孙的 .md 总数 */
  const totals = new Map<string, number>()
  const files: VaultTreeFile[] = []

  for (const entry of entries) {
    const rel = entry.relPath.replace(/^\/+/, '')
    if (!rel || !isMarkdownPath(rel)) continue
    if (isIgnoredRelPath(rel, ignore)) continue
    // 只处理请求目录之下的文件（'' = 整棵树）
    if (prefix !== '' && !rel.startsWith(prefix)) continue

    const parent = parentOf(rel)
    directCount.set(parent, (directCount.get(parent) ?? 0) + 1)
    let cursor = parent
    while (true) {
      totals.set(cursor, (totals.get(cursor) ?? 0) + 1)
      if (cursor === '') break
      cursor = parentOf(cursor)
    }

    if (parent === dirPath) files.push({ path: rel, name: baseName(rel), doc_id: entry.docId })
  }

  const dirs: VaultTreeDir[] = []
  for (const [path, total] of totals) {
    if (path === dirPath) continue
    // 只出直接子目录：其父目录正是本层
    if (parentOf(path) !== dirPath) continue
    dirs.push({ path, name: dirName(path), files: directCount.get(path) ?? 0, total })
  }

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  dirs.sort(byName)
  files.sort(byName)

  return { path: dirPath, dirs, files }
}
