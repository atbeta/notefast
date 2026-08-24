/**
 * 校验 i18n 完整性：
 *   bun scripts/check-i18n.ts              # 扫描全部 src
 *   bun scripts/check-i18n.ts <相对路径>    # 只校验指定文件（如 components/Sidebar.tsx）
 * 校验项：
 *   1. 每个 t()/i18next.t() key 都在 zh-CN 语言包里（缺翻译即退出码 1）
 *   2. en 语言包覆盖 zh-CN 的全部 key（保证切英文不漏 key）
 *   3. 同名语言包文件中同一 key 的行号在 zh-CN 与 en 完全一致（AGENTS.md 双语对齐约定）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import zhCN from '../src/i18n/zh-CN'
import en from '../src/i18n/en'

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

// 语言包对齐：en 必须覆盖 zh-CN 的所有 key（嵌套结构递归比对）
function collectKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.push(p)
    else out.push(...collectKeys(v as Record<string, unknown>, p))
  }
  return out
}
const zhKeys = new Set(collectKeys(zhCN as Record<string, unknown>))
const enKeys = new Set(collectKeys(en as Record<string, unknown>))
const missingEn = [...zhKeys].filter((k) => !enKeys.has(k))
if (missingEn.length > 0) {
  console.error(`[i18n] en 语言包缺少 ${missingEn.length} 个 key（zh-CN 有而 en 没有）：`)
  for (const k of missingEn.sort()) console.error(`  - ${k}`)
  process.exit(1)
}
console.log(`[i18n] OK：en 覆盖全部 ${zhKeys.size} 个 key`)

// 语言包行号对齐：同一 key 在 zh-CN 与 en 同名文件中必须处于同一行号。
// 按本仓库语言包格式（一行一个 key、纯对象嵌套、无数组）逐行扫描；
// 统计花括号前剔除字符串字面量，避免 {{placeholder}} 干扰。
const I18N_DIR = join(import.meta.dir, '../src/i18n')

function keyLines(path: string): Map<string, number> {
  const out = new Map<string, number>()
  const stack: string[] = []
  const stripStrings = (s: string) => s.replace(/"(?:\\.|[^"\\])*"/g, '')
  const lines = readFileSync(path, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = line.match(/^\s*"((?:\\.|[^"\\])*)"\s*:/)
    if (m) {
      const rest = stripStrings(line.slice(m[0].length))
      if (rest.includes('{')) stack.push(m[1]!)
      else out.set([...stack, m[1]!].join('.'), i + 1)
    }
    const closes = (stripStrings(line).match(/}/g) || []).length
    for (let c = 0; c < closes; c++) stack.pop()
  }
  return out
}

let misaligned = 0
for (const file of readdirSync(join(I18N_DIR, 'zh-CN')).filter((f) => f.endsWith('.json'))) {
  const zhMap = keyLines(join(I18N_DIR, 'zh-CN', file))
  const enMap = keyLines(join(I18N_DIR, 'en', file))
  for (const [key, line] of zhMap) {
    const enLine = enMap.get(key)
    if (enLine !== undefined && enLine !== line) {
      if (misaligned === 0) console.error('[i18n] 以下 key 在 zh-CN 与 en 中行号不一致：')
      console.error(`  - ${file} ${key}: zh-CN L${line} vs en L${enLine}`)
      misaligned++
    }
  }
}
if (misaligned > 0) {
  console.error(`[i18n] 共 ${misaligned} 处行号错位（新增/移动 key 时两边物理位置须保持一致）`)
  process.exit(1)
}
console.log('[i18n] OK：zh-CN 与 en 同名文件 key 行号全部对齐')

const CJK = /[\u4e00-\u9fff]/
const ALLOW = /i18n-allow/

/** 注释换成空格、保留换行，避免行号错位 */
function maskComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (full, pre: string) => pre + ' '.repeat(full.length - pre.length))
}

function maskRegexLiterals(line: string): string {
  return line.replace(/\/(?:\\\/|[^/\n])+\/[gimsuy]*/g, '')
}

const cjkHits: string[] = []
for (const file of walk(ROOT)) {
  if (file.includes('/__tests__/')) continue
  const rel = file.slice(ROOT.length + 1)
  const raw = readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  const masked = maskComments(raw).split('\n')
  for (let i = 0; i < masked.length; i++) {
    if (ALLOW.test(lines[i] ?? '')) continue
    if (CJK.test(maskRegexLiterals(masked[i]))) {
      cjkHits.push(`${rel}:${i + 1}  ${lines[i]!.trim().slice(0, 120)}`)
    }
  }
}

if (cjkHits.length > 0) {
  console.error(`[i18n] ${cjkHits.length} 处源码 CJK 字面量（用户文案请走 t()；注释/测试/正则已跳过；例外加 i18n-allow）：`)
  for (const h of cjkHits) console.error(`  - ${h}`)
  process.exit(1)
}
console.log('[i18n] OK：源码无未入包的 CJK 字面量')

