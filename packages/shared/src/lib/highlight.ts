/**
 * 代码语法高亮（highlight.js）
 *
 * 设计要点：
 * - 懒加载：首个代码块渲染时才异步拉取 core + 语言包，主包体积不受影响
 * - 按需注册 ~18 门常用语言，未知语言优雅降级为纯文本（调用方判空）
 * - 主题色在宿主的 index.css 里按设计 token 映射（低饱和、明暗双主题）
 */
import type { HLJSApi } from 'highlight.js'

let hljsPromise: Promise<HLJSApi> | null = null

/** 语言模块按需注册表（key = 注册名） */
const LANGUAGE_LOADERS = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  python: () => import('highlight.js/lib/languages/python'),
  bash: () => import('highlight.js/lib/languages/bash'),
  json: () => import('highlight.js/lib/languages/json'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  sql: () => import('highlight.js/lib/languages/sql'),
  rust: () => import('highlight.js/lib/languages/rust'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  css: () => import('highlight.js/lib/languages/css'),
  xml: () => import('highlight.js/lib/languages/xml'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  ini: () => import('highlight.js/lib/languages/ini'),
  diff: () => import('highlight.js/lib/languages/diff'),
} satisfies Record<string, () => Promise<{ default: (hljs: HLJSApi) => unknown }>>

/** 常见别名 → 注册名 */
const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  'c++': 'cpp',
  html: 'xml',
  vue: 'xml',
  toml: 'ini',
  conf: 'ini',
}

function getHljs(): Promise<HLJSApi> {
  if (!hljsPromise) {
    hljsPromise = (async () => {
      const { default: hljs } = await import('highlight.js/lib/core')
      await Promise.all(
        Object.entries(LANGUAGE_LOADERS).map(async ([name, load]) => {
          const mod = await load()
          hljs.registerLanguage(name, mod.default)
        }),
      )
      return hljs
    })()
  }
  return hljsPromise
}

/**
 * 高亮代码，返回 HTML（hljs 输出已转义）；语言不支持时返回 null（调用方回退纯文本）
 */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
  if (!lang.trim()) return null
  const mapped = LANG_ALIASES[lang.trim().toLowerCase()] ?? lang.trim().toLowerCase()
  const hljs = await getHljs()
  if (!hljs.getLanguage(mapped)) return null
  try {
    return hljs.highlight(code, { language: mapped }).value
  } catch {
    return null
  }
}
