/**
 * 文档 Markdown 导出用 frontmatter（投影，非运行时真相）
 *
 * DB（blocks 表）仍是唯一写入真相；本模块只在「便携导出 / 归档」时
 * 把 tags / 时间戳 / doc id 序列化进 YAML，便于跨工具携带元数据。
 * 不在编辑器加载路径（/export/markdown）使用。
 */

import type { BlockRow } from './types'
import { readTags } from './tags'

/** 导出时写入 YAML 的文档级元数据 */
export interface DocFrontmatterMeta {
  tags: string[]
  /** 创建时间（与 DB created_at 一致） */
  created: string
  /** 内容最后编辑时间（与 DB updated_at 一致） */
  modified: string
  /** 文档根 block id，便于回导识别；导入默认不按此静默覆盖 */
  notefast_id: string
}

/** 从文档根行投影 frontmatter（只读 DB 字段） */
export function docFrontmatterFromRow(
  row: Pick<BlockRow, 'id' | 'tags' | 'created_at' | 'updated_at'>,
): DocFrontmatterMeta {
  return {
    tags: readTags(row as BlockRow),
    created: row.created_at,
    modified: row.updated_at,
    notefast_id: row.id,
  }
}

/** YAML 双引号转义 */
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 标量是否需要加引号（含冒号/井号/起首特殊符、空白、非 ASCII 等稳妥加引）
 */
function needsYamlQuotes(s: string): boolean {
  if (s.length === 0) return true
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s)) return true
  if (/[\n\r:#]/.test(s) || /\s/.test(s)) return true
  // 纯数字 / bool 形态加引，避免被解析器当成非字符串
  if (/^(true|false|null|~)$/i.test(s)) return true
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return true
  return false
}

function yamlScalar(s: string): string {
  return needsYamlQuotes(s) ? yamlQuote(s) : s
}

/** 序列化 frontmatter 块（含首尾 ---，末尾多一个空行分隔正文） */
export function formatDocFrontmatter(meta: DocFrontmatterMeta): string {
  const lines: string[] = ['---']
  if (meta.tags.length === 0) {
    lines.push('tags: []')
  } else {
    lines.push('tags:')
    for (const tag of meta.tags) {
      lines.push(`  - ${yamlScalar(tag)}`)
    }
  }
  lines.push(`created: ${yamlScalar(meta.created)}`)
  lines.push(`modified: ${yamlScalar(meta.modified)}`)
  lines.push(`notefast_id: ${yamlScalar(meta.notefast_id)}`)
  lines.push('---')
  lines.push('')
  return lines.join('\n')
}

/** 在正文前拼接 frontmatter（body 可已含或不含尾换行） */
export function withDocFrontmatter(bodyMarkdown: string, meta: DocFrontmatterMeta): string {
  const body = bodyMarkdown.replace(/^\uFEFF/, '')
  return formatDocFrontmatter(meta) + body.replace(/^\n+/, '')
}

export interface StrippedFrontmatter {
  /** 去掉 frontmatter 后的正文 */
  body: string
  /** 解析到的字段；无 frontmatter 时为 null */
  meta: Partial<DocFrontmatterMeta> | null
}

/**
 * 剥离文首 NoteFast / 兼容 YAML frontmatter。
 * 仅当全文以 `---` 行开头时处理；解析失败则原样返回（避免误伤正文里的 ---）。
 */
export function stripDocFrontmatter(markdown: string): StrippedFrontmatter {
  const src = markdown.replace(/^\uFEFF/, '')
  if (!src.startsWith('---')) {
    return { body: src, meta: null }
  }
  // 首行必须是单独的 ---（允许尾空白）
  const firstNl = src.indexOf('\n')
  if (firstNl < 0) return { body: src, meta: null }
  if (src.slice(0, firstNl).trim() !== '---') return { body: src, meta: null }

  const rest = src.slice(firstNl + 1)
  const closeMatch = rest.match(/^\s*---\s*$/m)
  if (!closeMatch || closeMatch.index === undefined) {
    return { body: src, meta: null }
  }
  const yamlText = rest.slice(0, closeMatch.index)
  const after = rest.slice(closeMatch.index + closeMatch[0].length).replace(/^\n/, '')

  const meta = parseSimpleFrontmatter(yamlText)
  if (!meta) return { body: src, meta: null }
  return { body: after, meta }
}

/**
 * 极简 YAML 子集解析（仅我们写出的字段）。
 * 不引入 js-yaml；失败返回 null。
 */
function parseSimpleFrontmatter(yamlText: string): Partial<DocFrontmatterMeta> | null {
  const meta: Partial<DocFrontmatterMeta> = {}
  const lines = yamlText.split('\n')
  let i = 0
  let sawAny = false

  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      i++
      continue
    }

    if (trimmed === 'tags: []' || trimmed === 'tags:[]') {
      meta.tags = []
      sawAny = true
      i++
      continue
    }

    if (trimmed === 'tags:') {
      const tags: string[] = []
      i++
      while (i < lines.length) {
        const item = lines[i]!
        const m = item.match(/^\s*-\s+(.*)$/)
        if (!m) break
        tags.push(unquoteYaml(m[1]!.trim()))
        i++
      }
      meta.tags = tags
      sawAny = true
      continue
    }

    const kv = trimmed.match(/^(created|modified|notefast_id):\s*(.*)$/)
    if (kv) {
      const key = kv[1] as 'created' | 'modified' | 'notefast_id'
      meta[key] = unquoteYaml(kv[2]!.trim())
      sawAny = true
      i++
      continue
    }

    // 未知键：跳过一行（兼容未来字段），不整段失败
    i++
  }

  return sawAny ? meta : null
}

function unquoteYaml(raw: string): string {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    const inner = raw.slice(1, -1)
    if (raw.startsWith('"')) {
      return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
    return inner.replace(/''/g, "'")
  }
  return raw
}
