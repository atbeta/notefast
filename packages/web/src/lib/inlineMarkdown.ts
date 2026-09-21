/**
 * 行内 Markdown 的 token 定义与「上屏文本」提取。
 *
 * 支持：![image](url)、`code`、$math$、**bold**、*italic*、~~del~~、[text](url)、裸 URL
 * 单一正则扫描，非嵌套场景覆盖绝大多数笔记内容；image 必须在 link 之前匹配；
 * $math$ 紧随 code 之后（code 内不解析公式），在 bold/italic 之前（避免 * 被先行认领）。
 *
 * 为什么把正则放在 lib：**渲染与统计必须共用同一份 token 定义**。
 * 统计（docStats.ts）要算的是「读者在屏幕上看到多少字」，只要两边各写一份
 * 行内语法规则，迟早漂移成「字数说 120，正文看起来只有 80」这种谁也说不清的问题
 * （lector 的 findMatch.ts 头注释记着同一条教训：三处各写各的匹配必然走偏）。
 * 组件侧只 import 正则，不反向依赖组件——lib 不依赖 components 是本仓库既有分层。
 */
import { INLINE_MATH_SRC } from './katex'

export const INLINE_RE = new RegExp(
  [
    String.raw`(!\[[^\]]*\]\([^)\s]+\))`,
    '(`[^`]+`)',
    `(${INLINE_MATH_SRC})`,
    String.raw`(\*\*[^*\n]+\*\*)`,
    String.raw`(\*[^*\n]+\*)`,
    String.raw`(~~[^~\n]+~~)`,
    String.raw`(\[[^\]]+\]\([^)\s]+\))`,
    String.raw`(https?:\/\/[^\s<>()"]+)`,
  ].join('|'),
  'g',
)

/**
 * 取一段行内 Markdown 的**上屏文本**：屏幕上真正显示出来的字符。
 *
 * 分组下标与 BlockRenderer.renderInline 一一对应，改这里必须同步改那边
 * （test/docStats.test.ts 用真实渲染结果做等价性断言，漂移会红）。
 *
 * 口径（与 lector 的 core/stats.ts 同源，两处刻意不同的地方已注明）：
 * - 链接 `[文字](url)` 只留文字；裸 URL 整段保留——裸 URL 上屏就是它自己，
 *   而 `[文字](url)` 的地址是 href，读者看不到。
 * - 行内公式 `$tex$` 算 tex（KaTeX 渲出来的就是它）。
 * - 图片不计：它是图像，alt 只在加载失败与无障碍树里出现，
 *   lector 把 alt 计进去是因为它的预览把 alt 当文字兜底；notefast 的图片落在
 *   `<img alt>`，计进去会让一篇纯图文档显示成「有几百字」。
 */
export function renderedInlineText(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out += text.slice(last, idx)
    if (m[1]) {
      // 图片：不计（见上）
    } else if (m[2]) {
      out += m[2].slice(1, -1)
    } else if (m[3]) {
      out += m[3].slice(1, -1)
    } else if (m[4]) {
      out += renderedInlineText(m[4].slice(2, -2))
    } else if (m[5]) {
      out += renderedInlineText(m[5].slice(1, -1))
    } else if (m[6]) {
      out += renderedInlineText(m[6].slice(2, -2))
    } else if (m[7]) {
      const lm = m[7].match(/\[([^\]]+)\]\(([^)\s]+)\)/)
      if (lm) out += lm[1]
    } else if (m[8]) {
      // 裸 URL：含尾部标点整段上屏（renderInline 把它拆成 link + 尾标点两段显示）
      out += m[8]
    }
    last = idx + m[0].length
  }
  if (last < text.length) out += text.slice(last)
  return out
}
