/**
 * 私有评测集生成器（bun 脚本）
 *
 * 只读打开真实库的 notefast.db，提取文档标题 / tags / 时间戳（不导出正文），
 * 按规则生成查询集，写到 data/eval/private-queries.json（已 gitignore）。
 *
 * 用法：
 *   bun --filter @notefast/server eval:private [--data-dir ./data] [--out <path>]
 *
 * 生成规则（不调 LLM，纯模板）：
 * - title_exact：直接取标题（跳过过短 / 无意义标题）
 * - proper_noun：标题中的英文 / 数字 token
 * - chinese_semantic：标题转疑问句式模板
 * - temporal：结合 updated_at 的「最近写的关于 X 的笔记」
 *
 * 安全约束：数据库以 readonly 打开，任何情况下不写库；唯一写操作是输出 JSON 文件。
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

interface DocRow {
  id: string
  title: string
  tags: string
  created_at: string
  updated_at: string
}

interface GeneratedQuery {
  id: string
  query: string
  type: string
  relevant_docs: string[]
  note: string
}

/** 每类查询的上限（总计 ≤ 80） */
const QUOTA: Record<string, number> = {
  title_exact: 30,
  proper_noun: 20,
  chinese_semantic: 20,
  temporal: 10,
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--') && argv[i + 1] && !argv[i + 1]!.startsWith('--')) {
      args[a.slice(2)] = argv[i + 1]!
      i++
    }
  }
  return args
}

/** 过短 / 无意义标题不参与生成（「测试」「todo」这类标了也评不出东西） */
function isMeaningfulTitle(title: string): boolean {
  const t = title.trim()
  if (t.length < 4) return false
  return /[A-Za-z0-9一-鿿]/.test(t)
}

/** 标题中的英文 / 数字 token（专有名词候选） */
function extractProperNouns(title: string): string[] {
  const matches = title.match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) ?? []
  return [...new Set(matches)]
}

/** 截断过长标题，保证生成的查询像人话 */
function titleCore(title: string, max = 24): string {
  const t = title.trim()
  return t.length <= max ? t : t.slice(0, max)
}

function parseTags(raw: string): string[] {
  try {
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 仓库根目录（本文件在 packages/server/src/eval/ 下） */
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

/** 目录解析：相对路径先试 cwd，下面没有 notefast.db 再试仓库根 */
function resolveDataDir(p: string): string {
  if (isAbsolute(p)) return p
  const fromCwd = resolve(process.cwd(), p)
  if (existsSync(join(fromCwd, 'notefast.db'))) return fromCwd
  const fromRoot = resolve(REPO_ROOT, p)
  return fromRoot
}

function main(): void {
  // bun --filter 会把 cwd 切到包目录；数据目录优先取 cwd 下含 notefast.db 的，其次仓库根
  const args = parseArgs(process.argv.slice(2))
  const dataDir = resolveDataDir(args['data-dir'] ?? process.env.DATA_DIR ?? './data')
  const dbPath = join(dataDir, 'notefast.db')
  const outPath = args.out
    ? (isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out))
    : join(dataDir, 'eval', 'private-queries.json')

  if (!existsSync(dbPath)) {
    console.error(`未找到数据库：${dbPath}`)
    process.exit(1)
  }

  // readonly 打开：本脚本任何情况下不写库
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db
      .query(
        `SELECT id, content AS title, tags, created_at, updated_at
         FROM blocks
         WHERE type = 'document' AND is_deleted = 0 AND status = 'note' AND ai_exclude = 0
         ORDER BY created_at ASC`,
      )
      .all() as DocRow[]

    const docs = rows.filter((r) => isMeaningfulTitle(r.title))
    console.log(`📚 读取到 ${rows.length} 篇文档，其中 ${docs.length} 篇标题可用于生成查询`)

    const seen = new Set<string>()
    const counts: Record<string, number> = {}
    const queries: GeneratedQuery[] = []
    const push = (type: string, query: string, title: string, note: string): boolean => {
      if ((counts[type] ?? 0) >= (QUOTA[type] ?? 0)) return false
      const q = query.trim()
      if (!q || seen.has(q)) return false
      seen.add(q)
      counts[type] = (counts[type] ?? 0) + 1
      queries.push({
        id: `p${String(queries.length + 1).padStart(3, '0')}`,
        query: q,
        type,
        relevant_docs: [title],
        note,
      })
      return true
    }

    // title_exact：直接用标题
    for (const d of docs) {
      push('title_exact', d.title.trim(), d.title, 'auto: 标题原文')
    }

    // proper_noun：标题中的英文 / 数字 token
    for (const d of docs) {
      for (const token of extractProperNouns(d.title)) {
        push('proper_noun', token, d.title, `auto: 标题专有名词 ${token}`)
      }
    }

    // chinese_semantic：疑问句式模板，按序轮换
    const templates = ['{t}是什么', '{t}怎么做', '为什么{t}']
    docs.forEach((d, i) => {
      const tpl = templates[i % templates.length]!
      push('chinese_semantic', tpl.replace('{t}', titleCore(d.title)), d.title, 'auto: 标题疑问句模板')
    })

    // temporal：结合 updated_at 的时间查询（优先用首个 tag 作主题词）
    const recentFirst = [...docs].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    for (const d of recentFirst) {
      const tags = parseTags(d.tags)
      const topic = tags[0] ?? titleCore(d.title, 12)
      push('temporal', `最近写的关于${topic}的笔记`, d.title, `auto: 时间查询（updated_at=${d.updated_at}）`)
    }

    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify({ queries }, null, 2) + '\n', 'utf-8')

    console.log(`✅ 生成 ${queries.length} 条查询 → ${outPath}`)
    for (const [type, n] of Object.entries(counts)) {
      console.log(`   ${type}: ${n}`)
    }
  } finally {
    db.close()
  }
}

main()
