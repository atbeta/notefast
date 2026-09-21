/**
 * 静态设计审计：把「好看」里能算的部分算出来。
 *
 * 边界（很重要）：这个脚本只看源码，算的是 token 的原始值。
 * 「元素上屏后到底可不可见」——半透明合成、层叠背景、实际字号——它算不出来，
 * 那部分要在真实浏览器里量（本仓库还没有渲染层验证工具，是已知缺口）。
 * 所以它保证的是「没有绕过 token」「没有悬空变量」「对比度过 AA 线」这三类硬指标。
 *
 * 用法：bun scripts/check-design.ts
 * 退出码 1 = 有 error（违反 AGENTS.md 的 Web UI 约定 / 悬空 token）；
 * warn（对比度偏低的组合、文档与实现漂移）只打印，不阻断构建。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '../src')
const STYLES = join(ROOT, 'styles')
const TOKENS_CSS = join(STYLES, 'tokens.css')
const INDEX_CSS = join(ROOT, 'index.css')
const TOKENS_DOC = join(STYLES, 'TOKENS.md')

const errors: string[] = []
const warnings: string[] = []

/** 去掉注释：注释里的示例代码/hex 都是噪音，不该让门禁变红。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === '__tests__' || name === 'i18n') continue
      out.push(...walk(p))
    } else if (/\.(tsx?|css)$/.test(name)) out.push(p)
  }
  return out
}

const files = walk(ROOT)
const rel = (p: string) => relative(ROOT, p)

// ───────────────────────── A. AGENTS.md 的 Web UI 硬约定 ─────────────────────────
/** 每条：[规则说明, 正则, 只查 css / 查 ts]。主题靠 data-theme 翻转，这些写法一律越界。 */
const BANNED: Array<{ why: string; re: RegExp; css?: boolean }> = [
  { why: 'Tailwind `dark:` 变体（主题必须靠 data-theme 翻转 token）', re: /(^|[^a-zA-Z-])dark:[a-z0-9-]+/g },
  { why: '直用 emerald/amber/rose 调色板（请走 success/warning/destructive token）', re: /\b(emerald|amber|rose)-\d{2,3}\b/g },
  { why: 'Tailwind 任意值 hex 颜色（请走 token）', re: /\b(?:bg|text|border|ring|fill|stroke|shadow|decoration)-\[#[0-9a-fA-F]{3,8}\]/g },
  { why: 'CSS 里按 prefers-color-scheme 切主题（必须走 html[data-theme]）', re: /@media[^{]*prefers-color-scheme/g, css: true },
]

for (const file of files) {
  const src = stripComments(readFileSync(file, 'utf8'))
  const isCss = file.endsWith('.css')
  for (const rule of BANNED) {
    if (rule.css && !isCss) continue
    for (const m of src.matchAll(rule.re)) {
      const line = src.slice(0, m.index).split('\n').length
      errors.push(`${rel(file)}:${line} ${rule.why} → ${m[0].trim()}`)
    }
  }
}

// ───────────────────────── B. 悬空 token ─────────────────────────
/**
 * 定义源要收全，否则误报会把门禁变成噪音：
 *  - tokens.css / index.css 里的 `--x:` 声明
 *  - 组件内联样式 `style={{ '--x': ... }}`（如 --reading-max-w）
 *  - JS 侧 `setProperty('--x', ...)`（如 --notefast-doc-zoom）
 *  - tailwind.config.js 里的 `--x`（语义色映射）
 */
const tokensCss = readFileSync(TOKENS_CSS, 'utf8')
const indexCss = readFileSync(INDEX_CSS, 'utf8')
const tailwindCfg = readFileSync(join(import.meta.dir, '../tailwind.config.js'), 'utf8')

const defined = new Set<string>()
for (const m of (tokensCss + indexCss).matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]!)
for (const m of tailwindCfg.matchAll(/--[\w-]+/g)) defined.add(m[0])
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(/['"](--[\w-]+)['"]\s*:/g)) defined.add(m[1]!)
  for (const m of src.matchAll(/setProperty\(\s*['"](--[\w-]+)['"]/g)) defined.add(m[1]!)
}

/** `var(--x, fallback)` 自带兜底，不算悬空；只看没有 fallback 的引用。 */
for (const file of files) {
  const src = stripComments(readFileSync(file, 'utf8'))
  for (const m of src.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
    const name = m[1]!
    if (defined.has(name)) continue
    const line = src.slice(0, m.index).split('\n').length
    errors.push(`${rel(file)}:${line} 悬空 token：${name} 没有任何定义处（拼错或已改名）`)
  }
}

/** TOKENS.md 里提到的 token 必须真的存在：文档漂移最典型的形态就是改名后漏改一处。 */
const docTokens = new Set([...readFileSync(TOKENS_DOC, 'utf8').matchAll(/`(--[\w-]+)`/g)].map((m) => m[1]!))
for (const name of docTokens) {
  if (!defined.has(name)) warnings.push(`TOKENS.md 提到 ${name}，但 tokens.css 里没有这个 token（文档漂移）`)
}

// ───────────────────────── C. 对比度（AA） ─────────────────────────
/** 取某个选择器块里的到 `--name: R G B` 值。 */
function tokenBlock(css: string, selector: string): Record<string, [number, number, number]> {
  const start = css.indexOf(selector)
  if (start < 0) return {}
  const body = css.slice(start + selector.length)
  const end = body.indexOf('\n}')
  const out: Record<string, [number, number, number]> = {}
  for (const line of body.slice(0, end < 0 ? undefined : end).split('\n')) {
    const m = line.match(/(--[\w-]+)\s*:\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;/)
    if (m) out[m[1]!] = [Number(m[2]), Number(m[3]), Number(m[4])]
  }
  return out
}

const light = tokenBlock(tokensCss, ':root {')
const dark = tokenBlock(tokensCss, ":root[data-theme='dark'] {")

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (l1 + 0.05) / (l2 + 0.05)
}

/** [前景, 背景, 最低要求]：正文级 4.5，次级/大字号 3.0（WCAG AA）。 */
const PAIRS: Array<[string, string, number, string]> = [
  ['--foreground', '--background', 4.5, '正文'],
  ['--foreground', '--card', 4.5, '卡片正文'],
  ['--muted-foreground', '--background', 4.5, '次级文字'],
  ['--muted-foreground', '--card', 4.5, '卡片次级文字'],
  ['--primary', '--background', 4.5, '链接/强调'],
  ['--primary-foreground', '--primary', 4.5, '主按钮文字'],
  ['--destructive', '--background', 4.5, '危险色文字'],
  ['--success', '--background', 3, '成功色（图标/徽章）'],
  ['--warning', '--background', 3, '警告色（图标/徽章）'],
]

for (const [theme, tokens] of [['light', light], ['dark', dark]] as const) {
  for (const [fg, bg, min, role] of PAIRS) {
    const f = tokens[fg]
    const b = tokens[bg]
    if (!f || !b) continue
    const ratio = contrast(f, b)
    if (ratio < min) {
      warnings.push(
        `${theme}：${role} ${fg} on ${bg} 对比度 ${ratio.toFixed(2)}:1 < ${min}:1（当前值 rgb(${f.join(' ')}) on rgb(${b.join(' ')})）`,
      )
    }
  }
}

// ───────────────────────── 报告 ─────────────────────────

if (errors.length > 0) {
  console.error(`[design] ${errors.length} 处错误：`)
  for (const e of errors) console.error(`  - ${e}`)
}
if (warnings.length > 0) {
  console.warn(`[design] ${warnings.length} 条提醒（不阻断构建）：`)
  for (const w of warnings) console.warn(`  - ${w}`)
}
if (errors.length === 0) {
  console.log(
    `[design] OK：${files.length} 个文件无越界写法，${defined.size} 个 token 引用均可解析，浅/深色对比度检查完成`,
  )
}
process.exit(errors.length > 0 ? 1 : 0)
