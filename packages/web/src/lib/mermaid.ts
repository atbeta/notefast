/**
 * Mermaid 图表渲染（懒加载）
 *
 * - 首个 mermaid 块才拉取库，避免撑大主包
 * - 按 data-theme 切换 default / dark
 * - securityLevel: strict，降低 SVG/脚本注入风险
 */

import type mermaidApi from 'mermaid'

type Mermaid = typeof mermaidApi

let mermaidPromise: Promise<Mermaid> | null = null
let lastTheme: 'default' | 'dark' | null = null
let renderSeq = 0

function getMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

function applyTheme(mermaid: Mermaid, theme: 'light' | 'dark'): void {
  const next = theme === 'dark' ? 'dark' : 'default'
  if (lastTheme === next) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: next,
    // 避免 mermaid 在失败时往 DOM 注入默认错误 UI（我们自己展示）
    suppressErrorRendering: true,
  })
  lastTheme = next
}

/** 生成全局唯一的 mermaid render id（库要求 id 不重复） */
export function nextMermaidId(): string {
  renderSeq += 1
  return `nf-mmd-${renderSeq}`
}

/**
 * 将 mermaid 源码渲染为 SVG 字符串。
 * 语法错误时抛出 Error（message 可供 UI 展示）。
 */
export async function renderMermaidSvg(
  code: string,
  theme: 'light' | 'dark',
  id = nextMermaidId(),
): Promise<string> {
  const mermaid = await getMermaid()
  applyTheme(mermaid, theme)
  const { svg } = await mermaid.render(id, code.trim())
  return svg
}
