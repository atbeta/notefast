/**
 * Mermaid 图表渲染（懒加载）
 *
 * - 首个 mermaid 块才拉取库，避免撑大主包
 * - 按 data-theme 切换 default / dark，画布与字体绑 token（不写死 hex / 字体名）
 * - securityLevel: strict，降低 SVG/脚本注入风险
 * - 渲染结果按 `theme::code` 缓存（上限 200），**失败不入缓存**
 */

import type mermaidApi from 'mermaid'
import { createLruCache } from './lruCache'

type Mermaid = typeof mermaidApi

let mermaidPromise: Promise<Mermaid> | null = null
let lastTheme: 'default' | 'dark' | null = null
let renderSeq = 0

/** 缓存上限：一篇文档里的图远少于这个数，超出只淘汰最久未用的。 */
export const MERMAID_CACHE_MAX = 200

/** 已渲染的 SVG：key = `theme::code`，value = 那次渲染用的 id（命中时要换成新的）。 */
const svgCache = createLruCache<string, { svg: string; id: string }>(MERMAID_CACHE_MAX)

function getMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

function cssVar(name: string): string {
  if (typeof document === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * 把 `--x: R G B` 形式的 token 变成 CSS 颜色。
 *
 * 用逗号分隔而不是 `rgb(R G B)` 空格写法：mermaid 内部用 khroma 解析这些颜色
 * 并派生节点底色/边框，空格写法不一定被它认（逗号写法两边都认）。
 */
function cssRgbToken(name: string, fallback: string): string {
  const raw = cssVar(name)
  const parts = raw.split(/\s+/).filter(Boolean)
  return parts.length === 3 ? `rgb(${parts.join(', ')})` : fallback
}

/**
 * 把一段 SVG 里出现的旧 render id 整体换成新 id。
 *
 * 为什么要这一步：mermaid 会把 render id 写进很多地方——根 `<svg id>`、内部
 * `<style>` 的选择器、箭头 marker 的 id 与 `url(#…)` 引用。缓存命中时若原样复用，
 * 同一张图在页面里出现两次就会有**重复 id**，而 mermaid 自己渲染下一张图时是按 id
 * 找容器的，拿到旧节点就会画错。id 是 `nf-mmd-N` 这种独特前缀，整体替换安全。
 */
export function reidMermaidSvg(svg: string, fromId: string, toId: string): string {
  if (!fromId || fromId === toId) return svg
  return svg.split(fromId).join(toId)
}

/** 读缓存并刷新新鲜度。 */
function cacheGet(key: string): { svg: string; id: string } | null {
  return svgCache.get(key)
}

function cacheSet(key: string, value: { svg: string; id: string }): void {
  svgCache.set(key, value)
}

/** 清空渲染缓存（测试与「换了 mermaid 配置」时用）。 */
export function clearMermaidCache(): void {
  svgCache.clear()
}

function applyTheme(mermaid: Mermaid, theme: 'light' | 'dark'): void {
  const next = theme === 'dark' ? 'dark' : 'default'
  if (lastTheme === next) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: next,
    themeVariables: {
      // 画布跟 data-theme 的 --card 对齐，不写死 hex
      background: cssRgbToken('--card', theme === 'dark' ? '#202020' : '#ffffff'),
      // 字体必须显式绑：不设时 mermaid 用自带的 'trebuchet ms'，图表字与界面脱节
      fontFamily: cssVar('--font-sans') || 'sans-serif',
      // 字号跟阅读正文字阶走（与 --text-lg 同一档），图表里的字不该自成一套
      fontSize: cssVar('--text-lg') || '16px',
      // 标签色跟正文墨色，避免图表里出现一套独立的中性色
      textColor: cssRgbToken('--foreground', theme === 'dark' ? '#f0f0f0' : '#1a1a1a'),
    },
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
 *
 * 缓存只记成功结果：一次失败（例如动态 import 拿到 504）若被记住，
 * 会把整个会话的这张图永久钉死，之后每次重试都拿到同一个失败
 * （lector mermaid.ts 记着这条教训）。命中缓存时把 id 换成本次的新 id。
 */
export async function renderMermaidSvg(
  code: string,
  theme: 'light' | 'dark',
  id = nextMermaidId(),
): Promise<string> {
  const source = code.trim()
  const key = `${theme}::${source}`
  const hit = cacheGet(key)
  if (hit) return reidMermaidSvg(hit.svg, hit.id, id)

  const mermaid = await getMermaid()
  applyTheme(mermaid, theme)
  const { svg } = await mermaid.render(id, source)
  cacheSet(key, { svg, id })
  return svg
}
