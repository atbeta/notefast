/**
 * ChatMarkdown 的数学公式分派判定（纯函数，便于单测）。
 *
 * mdast-util-math@3（remark-math@6）经 remark-rehype 后的实测输出约定：
 * - 行内 `$...$`（含单行 `$$x^2$$`）→ `<code class="language-math math-inline">`
 * - 块级 `$$\n...\n$$`（多行围栏形式）→ `<pre><code class="language-math math-display">`
 * - ```math 围栏（普通 code 节点）→ `<code class="language-math">`，按块级处理
 *
 * 注意：micromark-extension-math 无 Pandoc 空白/数字守卫，`$5 - $10` 这类货币
 * 写法也会被解析为 inlineMath（实测见 __tests__/chatMath.test.ts）——已知接受项，
 * 靠服务端 prompt 约定模型少输出裸露货币区间 + MathInline 渲染失败回退原文兜底。
 */

/** 块级公式语言别名（与阅读态 BlockRenderer 的 ```math 围栏别名集一致） */
const MATH_LANGUAGES = new Set(['math', 'latex', 'katex', 'tex'])

export type ChatMathKind = 'inline' | 'display' | null

/**
 * code className → 数学类型判定。
 * math-inline / math-display 标记优先于 language-* 判定：
 * `language-math math-inline` 同时含两者，不先判 inline 会被误当块级。
 */
export function classifyChatMath(codeClass: string | undefined): ChatMathKind {
  if (!codeClass) return null
  if (/(^|\s)math-inline(\s|$)/.test(codeClass)) return 'inline'
  if (/(^|\s)math-display(\s|$)/.test(codeClass)) return 'display'
  const match = /language-(\w+)/.exec(codeClass)
  if (match && MATH_LANGUAGES.has(match[1].toLowerCase())) return 'display'
  return null
}
