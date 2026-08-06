/**
 * KaTeX 数学公式渲染（懒加载）
 *
 * - 首个数学块才拉取库与 CSS，避免撑大主包（与 lib/mermaid.ts 同模式）
 * - 字体走 katex npm 包内 woff2，由 vite 打包自托管（零外部 CDN 约定）
 * - trust 保持默认 false：禁用 \href / \html* 等危险命令，
 *   renderToString 输出可安全用于 dangerouslySetInnerHTML
 * - 行内公式的匹配规则见 INLINE_MATH_SRC（Pandoc 风格，防货币 $100 误伤）
 */

import type katexApi from 'katex'

type Katex = typeof katexApi

let katexPromise: Promise<Katex> | null = null

function getKatex(): Promise<Katex> {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ]).then(([m]) => m.default)
  }
  return katexPromise
}

/**
 * 渲染为 HTML 字符串；语法错误时抛出 Error（message 可供 UI 展示）。
 * strict: 'warn'——Unicode 引号等严格性警告不视为错误。
 */
export async function renderMathToHtml(tex: string, displayMode: boolean): Promise<string> {
  const katex = await getKatex()
  return katex.renderToString(tex.trim(), {
    displayMode,
    throwOnError: true,
    strict: 'warn',
  })
}

/**
 * 行内公式 $...$ 匹配（Pandoc 规则，无捕获组）：
 * - 开 $ 后不能是空格、闭 $ 前不能是空格（`$ 100 $` 不匹配）
 * - 闭 $ 后不能紧跟数字（`$5-$10`、`$x$2` 等货币/编号场景不匹配）
 * 不跨行、不匹配 $$（块级公式用 ```math 围栏）
 */
export const INLINE_MATH_SRC = String.raw`\$(?:[^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)`
