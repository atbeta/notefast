/**
 * NoteFastEditor 文件读写层：与壳层（macOS WKWebView / Tauri）经 postMessage 交互。
 *
 * 两级策略：
 * 1. 原生壳（isNativeShell）：`window.webkit.messageHandlers.notefast.postMessage`
 *    上行 `fs.read` / `fs.write` / `fs.saveAs` / `fs.open`，壳层回 `fileLoaded` /
 *    `fileSaved` / `error` 下行事件（M3 接线）。
 * 2. 浏览器形态（dev / 直接访问）：File System Access API（showOpenFilePicker /
 *    showSaveFilePicker）；不可用（如 Safari 旧版）时降级到内存「新建文档」+
 *    下载导出，保持可用。
 *
 * 无论是哪种，编辑器都只面对一个「已打开文件」的内存态：{ path, content, dirty }。
 * 「导入到 NoteFast」永远用内存内容推服务器，不动磁盘文件（决策定）。
 */

import { isNativeShell } from './shell'

/** 上行到壳层的消息契约（M3 壳层按 type 分派） */
export type FileBridgeMessage =
  | { type: 'fs.read'; path: string }
  | { type: 'fs.write'; path: string; content: string }
  | { type: 'fs.saveAs'; content: string; suggestedName?: string }
  | { type: 'fs.open'; accept?: string[] }

/** 壳层下行的打开/保存结果（web 侧监听 document 事件） */
export interface OpenedFile {
  path: string
  name: string
  content: string
}

export interface SavedFile {
  path: string
}

/** 当前打开的文件内存态 */
export interface OpenFile {
  path: string
  name: string
  content: string
  /** 磁盘内容与内存内容是否一致（未保存的编辑） */
  dirty: boolean
}

const BRIDGE_EVENT = 'notefast:file'

type NativeBridge = {
  webkit?: { messageHandlers?: { notefast?: { postMessage: (message: unknown) => void } } }
}

function postToShell(message: FileBridgeMessage): void {
  const w = window as unknown as NativeBridge
  w.webkit?.messageHandlers?.notefast?.postMessage(message)
}

// ─── 浏览器 File System Access API 封装 ────────────────────────────────

interface FsAnchoredHandle {
  fileHandle: FileSystemFileHandle
  dirty: boolean
}

let browserHandle: FsAnchoredHandle | null = null

/** 浏览器读取本地 .md（File System Access API）；不可用返回 null */
export async function openFilePicker(): Promise<OpenedFile | null> {
  if (typeof window === 'undefined') return null
  const picker = (window as unknown as { showOpenFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle[]> })
    .showOpenFilePicker
  if (!picker) return null
  try {
    const handles = await picker({
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.txt'] } }],
    })
    const handle = handles[0]
    const file = await handle.getFile()
    const content = await file.text()
    browserHandle = { fileHandle: handle, dirty: false }
    return { path: file.name, name: file.name, content }
  } catch (e) {
    // 用户取消选择（AbortError）不算错误
    if ((e as Error)?.name === 'AbortError') return null
    throw e
  }
}

/** 浏览器保存到当前句柄；无句柄则走「另存为」 */
async function browserSave(content: string): Promise<string | null> {
  if (!browserHandle) return browserSaveAs(content)
  const writable = await browserHandle.fileHandle.createWritable()
  await writable.write(content)
  await writable.close()
  browserHandle.dirty = false
  return browserHandle.fileHandle.name
}

/** 浏览器另存为（导出）；无 File System Access API 时下载到本地 */
async function browserSaveAs(content: string): Promise<string | null> {
  const picker = (window as unknown as { showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle> })
    .showSaveFilePicker
  if (!picker) {
    // 降级：Blob 下载
    const blob = new Blob([content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '未命名.md'
    a.click()
    URL.revokeObjectURL(url)
    return null
  }
  const handle = await picker({
    types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.txt'] } }],
  })
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
  browserHandle = { fileHandle: handle, dirty: false }
  return handle.name
}

// ─── 统一对外 API ─────────────────────────────────────────────────────

/** 下行的壳层事件监听器（原生壳） */
export function onFileEvent(handler: (msg: { type: 'fileLoaded'; file: OpenedFile } | { type: 'fileSaved'; file: SavedFile } | { type: 'error'; message: string }) => void): () => void {
  const listener = (e: Event) => {
    handler((e as CustomEvent).detail)
  }
  window.addEventListener(BRIDGE_EVENT, listener)
  return () => window.removeEventListener(BRIDGE_EVENT, listener)
}

/** 壳层/浏览器下行事件也会经此函数派发（浏览器形态内部直接调用，原生壳由壳层注入） */
export function dispatchFileEvent(detail: unknown): void {
  window.dispatchEvent(new CustomEvent(BRIDGE_EVENT, { detail }))
}

/**
 * 打开文件：原生壳走 postMessage，浏览器走 File System Access API。
 * 返回 OpenedFile（path/name/content），不可用或取消返回 null。
 */
export async function requestOpenFile(): Promise<OpenedFile | null> {
  if (isNativeShell()) {
    postToShell({ type: 'fs.open', accept: ['md', 'markdown', 'mdown', 'mkd', 'txt'] })
    return null // 结果经 fileLoaded 事件异步回来
  }
  return openFilePicker()
}

/** 读取指定路径全文（原生壳） */
export async function readFile(path: string): Promise<string> {
  if (isNativeShell()) {
    postToShell({ type: 'fs.read', path })
    return '' // 结果经 fileLoaded 事件异步回来
  }
  throw new Error('readFile 仅原生壳可用')
}

/**
 * 保存到当前文件：原生壳 postMessage，浏览器写回已选句柄。
 * 返回最终文件名（另存为可能改名）；原生壳异步，立即返回当前名。
 */
export async function saveFile(path: string, content: string): Promise<string | null> {
  if (isNativeShell()) {
    postToShell({ type: 'fs.write', path, content })
    return null
  }
  return browserSave(content)
}

/** 另存为：原生壳弹系统保存面板，浏览器 File System Access API / 下载降级 */
export async function saveFileAs(content: string): Promise<string | null> {
  if (isNativeShell()) {
    postToShell({ type: 'fs.saveAs', content, suggestedName: '未命名.md' })
    return null
  }
  return browserSaveAs(content)
}

/** 新建空白文档（无路径，内存态） */
export function newFile(): OpenFile {
  return { path: '', name: '未命名.md', content: '', dirty: false }
}
