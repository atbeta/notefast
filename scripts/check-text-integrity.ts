/**
 * 文本完整性守卫：挡住**新引入**的替换字符（U+FFFD）。
 *
 * 为什么必须有它：仓库里这一类的腐坏不是一次事故，是历次编辑攒出来的——
 * 某些非 UTF-8 感知的读写工具（PowerShell 的 Get-Content/Set-Content 往返、
 * 临时脚本走文本管道）会把中文写成 U+FFFD。注释里的腐坏只影响可读性，
 * **但同一件事落在用户可见的字符串里就是乱码**。只清存量、不管入口，
 * 过几天又是一片，所以这里盯的是「这次改动的行」。
 *
 * 两种模式：
 *   bun run scripts/check-text-integrity.ts            # 新增行（默认：CI 用 BASE..HEAD，本机用暂存区）
 *   bun run scripts/check-text-integrity.ts --all      # 全仓（去掉注释后扫，存量里注释中的例子不算）
 *
 * 三条纪律：
 *  1. **只看新增行**。存量是另一笔账，不该让守卫在无关改动上变红。
 *  2. **拿不到提交区间就 warn + exit 0**。「无法判断」不该变成「构建坏了」。
 *  3. 全仓模式先剥注释：注释里可能出现故意写坏的例子（描述历史事故），那不是缺陷。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO = join(import.meta.dir, '..')
const BAD = '\uFFFD'

/** 扫描范围：源码与配置。json/md 可能是刻意的测试数据，不纳入。 */
const EXTS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|css|rs|swift|html|yml|yaml|toml|sh)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-engine', 'target', '.git', 'data', 'build', '.turbo'])

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...filesUnder(p))
    else if (EXTS.test(name)) out.push(p)
  }
  return out
}

/** 去掉注释：注释里的坏字符是历史的记述，不是要挡的缺陷。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*#.*$/gm, '')
}

function scanTree(): string[] {
  const hits: string[] = []
  for (const file of filesUnder(REPO)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    if (!text.includes(BAD)) continue
    text.split('\n').forEach((line, i) => {
      if (line.includes(BAD)) hits.push(`${relative(REPO, file)}:${i + 1}  ${line.trim().slice(0, 120)}`)
    })
  }
  return hits
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** 取新增行的来源：优先 CI 给的 base（GitHub 提供 BASE_SHA），否则与 HEAD 比暂存区 + 工作区。 */
function addedLines(): { label: string; lines: string[] } | null {
  const base = process.env.BASE_SHA || process.env.GITHUB_BASE_SHA
  const range = base ? [`${base}...HEAD`] : null
  const diff = range
    ? git(['diff', '-U0', ...range])
    : (() => {
        const staged = git(['diff', '-U0', '--cached'])
        const unstaged = git(['diff', '-U0'])
        if (staged === null && unstaged === null) return null
        return `${staged ?? ''}${unstaged ?? ''}`
      })()
  if (diff === null) return null
  const lines = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
  // 本机模式还要算上**未跟踪的新文件**：git diff 看不到它们，
  // 而「新建文件时从别处粘一段被腐坏的文本」正是最常见的入口。
  if (!range) {
    const untracked = git(['ls-files', '--others', '--exclude-standard'])
    for (const file of (untracked ?? '').split('\n')) {
      if (!file || !EXTS.test(file)) continue
      try {
        lines.push(...readFileSync(join(REPO, file), 'utf8').split('\n'))
      } catch {
        /* 文件在这期间被删掉了：忽略 */
      }
    }
  }
  return { label: range ? range[0]! : '暂存区 + 工作区 + 未跟踪新文件', lines }
}

if (process.argv.includes('--all')) {
  const hits = scanTree()
  if (hits.length > 0) {
    console.error(`[text] 全仓发现 ${hits.length} 处替换字符 U+FFFD（注释之外）：`)
    for (const h of hits) console.error(`  - ${h}`)
    process.exit(1)
  }
  console.log('[text] OK：全仓无替换字符（注释之外）')
  process.exit(0)
}

const added = addedLines()
if (!added) {
  console.warn('[text] 取不到 git 差异区间，跳过本次检查（守卫不该因为拿不到历史而让流水线变红）')
  process.exit(0)
}
const hits = added.lines
  .map((line) => (line.includes(BAD) ? line : null))
  .filter((l): l is string => l !== null)
if (hits.length > 0) {
  console.error(`[text] 本次改动新增了 ${hits.length} 行替换字符 U+FFFD（来源：${added.label}）：`)
  for (const h of hits) console.error(`  - ${h.trim().slice(0, 120)}`)
  console.error('  常见成因：PowerShell Get-Content/Set-Content 往返、脚本走文本管道、非 UTF-8 读写。')
  process.exit(1)
}
// 自报盲区：在 CI 里一行都没扫到，说明区间没接上（守卫形同没跑），这也要说出来
if (added.lines.length === 0 && process.env.CI) {
  console.warn(`[text] 区间 ${added.label} 没有解析出任何新增行，本次检查实际没扫到东西——请确认 BASE_SHA`)
}
console.log(`[text] OK：本次改动无新增替换字符（来源：${added.label}）`)
