/**
 * 校验 i18n 完整性：
 *   bun scripts/check-i18n.ts              # 扫描全部 src
 *   bun scripts/check-i18n.ts <相对路径>    # 只校验指定文件（如 components/Sidebar.tsx）
 * 用法：把 t()/i18next.t() 调用的 key 与 zh-CN 语言包比对，缺翻译即退出码 1。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import zhCN from '../src/i18n/zh-CN'

const ROOT = join(import.meta.dir, '../src')
const KEY_RE = /\bt\((['"`])([\w.-]+)\1/g
const PREFIX_RE = /\b(?:i18next|i18n)\.t\((['"`])([\w.-]+)\1/g

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'i18n') continue
      out.push(...walk(p))
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

/** 去掉行注释与块注释，避免把文档里的 t('key') 示例当真实调用 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\/\/.*$/g, '')
}

function hasKey(obj: Record<string, unknown>, path: string): boolean {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return false
    cur = (cur as Record<string, unknown>)[seg]
  }
  return typeof cur === 'string'
}

const pack = zhCN as Record<string, unknown>
const missing = new Set<string>()
let total = 0

function collect(file: string): void {
  const src = stripComments(readFileSync(file, 'utf8'))
  for (const m of src.matchAll(KEY_RE)) {
    total++
    if (!hasKey(pack, m[2])) missing.add(m[2])
  }
  for (const m of src.matchAll(PREFIX_RE)) {
    total++
    if (!hasKey(pack, m[2])) missing.add(m[2])
  }
}

if (process.argv[2]) {
  collect(join(ROOT, process.argv[2]))
} else {
  for (const file of walk(ROOT)) collect(file)
}

if (missing.size > 0) {
  console.error(`[i18n] ${missing.size} 个 key 缺少翻译（共扫描 ${total} 次调用）：`)
  for (const k of [...missing].sort()) console.error(`  - ${k}`)
  process.exit(1)
}
console.log(`[i18n] OK：${total} 次 t() 调用全部有对应翻译`)
