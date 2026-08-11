/**
 * 文档阅读 / 编辑字号（demo 给别人看时放大；平时回归默认）
 *
 * 全局一份（localStorage 持久化），所有 doc 共享；阅读 / 编辑都按当前档。
 * 4 档：S=12 / M=14 / L=17 / XL=20 px——选 4 档是因为 S/M/L 跨度太大时 17 → 12 跳幅明显，
 * 17 → 20 也跳幅明显，加 XL 给"投影 / 远观"留一档位几乎不增加 UI 复杂度。
 *
 * 应用方式：main.tsx 在订阅里把 `SIZES[size]` 写到 `:root` 的
 * `--notefast-doc-font-size` CSS 变量；BlockRenderer 与 CodeMirror `.cm-content` 都
 * 引用这个变量，文字大小 / 行高 / 表格字号全跟着 em 自然缩放。
 */

import { useSyncExternalStore, type ReactElement } from 'react'

export type DocFontSize = 'sm' | 'md' | 'lg' | 'xl'

const STORAGE_KEY = 'notefast.docFontSize'

/** 4 档：S/M/L/XL；新增档位在 SIZE_ORDER 末尾加，UI 自动多一格 */
export const SIZE_ORDER: readonly DocFontSize[] = ['sm', 'md', 'lg', 'xl'] as const

export const SIZES: Record<DocFontSize, { px: number; labelKey: string }> = {
  sm: { px: 14, labelKey: 'doc.fontSize.sm' },
  md: { px: 16, labelKey: 'doc.fontSize.md' },
  lg: { px: 19, labelKey: 'doc.fontSize.lg' },
  xl: { px: 22, labelKey: 'doc.fontSize.xl' },
}

const DEFAULT: DocFontSize = 'md'

function isSize(v: unknown): v is DocFontSize {
  return typeof v === 'string' && v in SIZES
}

let current: DocFontSize = DEFAULT
const listeners = new Set<() => void>()

function load(): void {
  if (typeof window === 'undefined') return
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (isSize(v)) current = v
  } catch {
    /* localStorage 可能被禁用（隐身模式 / 隐私设置）—— 走默认即可 */
  }
}

function set(v: DocFontSize): void {
  current = v
  try {
    if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, v)
  } catch {
    /* 同上 */
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): DocFontSize {
  return current
}

function getServerSnapshot(): DocFontSize {
  return DEFAULT
}

/** 当前字号档位（订阅） */
export function useDocFontSize(): DocFontSize {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** 当前字号像素值（订阅，返回 number 方便直接 style={{ fontSize: ... }} 用） */
export function useDocFontSizePx(): number {
  return SIZES[useDocFontSize()].px
}

/** 设置档位（直接调用，例如按钮 onClick） */
export function setDocFontSize(size: DocFontSize): void {
  if (current !== size) set(size)
}

/** 循环切换（键盘快捷键 Ctrl+=/Ctrl+- 用） */
export function cycleDocFontSize(dir: 1 | -1): DocFontSize {
  const i = SIZE_ORDER.indexOf(current)
  const next = SIZE_ORDER[(i + dir + SIZE_ORDER.length) % SIZE_ORDER.length]!
  set(next)
  return next
}

/** 复位到默认档（键盘 Ctrl+0 用） */
export function resetDocFontSize(): DocFontSize {
  set(DEFAULT)
  return DEFAULT
}

// 模块加载时尝试从 localStorage 还原（SSR / 测试环境无害）
load()
/**
 * 把当前字号写到 :root 的 CSS 变量。App 树里挂载一次即可
 * （放在 <ToastProvider> 之后、所有 Routes 之前）。
 * 渲染 null — 纯副作用组件。
 */
export function DocFontSizeApplier(): ReactElement | null {
  const size = useDocFontSize()
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--notefast-doc-font-size', `${SIZES[size].px}px`)
  }
  return null
}