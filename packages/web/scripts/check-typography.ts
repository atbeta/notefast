/**
 * 拦截 UI 字号任意值，逼回 token scale。
 *   bun scripts/check-typography.ts
 * 白名单：注释、测试、行尾 `typography-allow`。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '../src')
const ARB = /text-\[(\d+(?:\.\d+)?)px\]/g
const ALLOW = /typography-allow/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === '__tests__' || name === 'i18n') continue
      out.push(...walk(p))
    } else if (/\.(tsx|ts)$/.test(name)) out.push(p)
  }
  return out
}

const hits: string[] = []
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (ALLOW.test(line) || /^\s*\/\//.test(line)) continue
    line.replace(ARB, (_m, px) => {
      hits.push(`${relative(ROOT, file)}:${i + 1}  text-[${px}px]`)
      return ''
    })
  }
}

if (hits.length > 0) {
  console.error(`[typography] ${hits.length} 处任意值字号（请改 text-2xs/xs/sm/base/md/lg/h1…）：`)
  for (const h of hits) console.error(`  - ${h}`)
  process.exit(1)
}
console.log('[typography] OK：无 text-[Npx] 任意值')
