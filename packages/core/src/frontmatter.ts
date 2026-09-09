/**
 * 文档 Markdown 导出用 frontmatter（投影，非运行时真相）
 *
 * DB（blocks 表）仍是唯一写入真相；本模块只在「便携导出 / 归档」时
 * 把 tags / 时间戳 / doc id 序列化进 YAML，便于跨工具携带元数据。
 * 不在编辑器加载路径（/export/markdown）使用。
 */

import type { BlockRow } from './types'
import { normalizeTagList, readTags } from './tags'

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
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true
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

/**
 * 从 frontmatter 读到的字段。
 * 导出投影（tags / created / modified / notefast_id）+ vault 写回用的 NoteFast 元数据键。
 */
export interface ParsedFrontmatterMeta extends Partial<DocFrontmatterMeta> {
  /** `notefast_ai_exclude: true`；缺省 / 无法识别时不出现（调用方按 false 处理） */
  notefast_ai_exclude?: boolean
  /** `notefast_status: inbox`；缺省 / 无法识别时不出现（调用方按 note 处理） */
  notefast_status?: 'inbox' | 'note'
}

export interface StrippedFrontmatter {
  /** 去掉 frontmatter 后的正文 */
  body: string
  /** 解析到的字段；无 frontmatter 时为 null */
  meta: ParsedFrontmatterMeta | null
  /** frontmatter 原文（不含首尾 `---`），供 vault 写回做行级透传；无 frontmatter 时为 null */
  raw: string | null
}

/**
 * 把 YAML 里的 created / modified 收成 DB 时间串（`YYYY-MM-DD HH:MM:SS.sss`，UTC）。
 * 接受自家导出格式、ISO（T / 可选 Z）、以及只有日期的写法；无法识别则返回 null。
 */
export function parseImportedTimestamp(raw: string | undefined): string | null {
  if (!raw) return null
  const s = raw.trim()
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?)?Z?$/)
  if (!m) return null
  const date = m[1]!
  const time = m[2] ?? '00:00:00'
  const frac = `.${((m[3] ?? '.000').slice(1) + '000').slice(0, 3)}`
  return `${date} ${time}${frac}`
}

/**
 * 剥离文首 NoteFast / 兼容 YAML frontmatter。
 * 仅当全文以 `---` 行开头时处理；解析失败则原样返回（避免误伤正文里的 ---）。
 */
export function stripDocFrontmatter(markdown: string): StrippedFrontmatter {
  const src = markdown.replace(/^\uFEFF/, '')
  if (!src.startsWith('---')) {
    return { body: src, meta: null, raw: null }
  }
  // 首行必须是单独的 ---（允许尾空白）
  const firstNl = src.indexOf('\n')
  if (firstNl < 0) return { body: src, meta: null, raw: null }
  if (src.slice(0, firstNl).trim() !== '---') return { body: src, meta: null, raw: null }

  const rest = src.slice(firstNl + 1)
  const closeMatch = rest.match(/^\s*---\s*$/m)
  if (!closeMatch || closeMatch.index === undefined) {
    return { body: src, meta: null, raw: null }
  }
  const yamlText = rest.slice(0, closeMatch.index)
  const after = rest.slice(closeMatch.index + closeMatch[0].length).replace(/^\n/, '')

  const meta = parseSimpleFrontmatter(yamlText)
  if (!meta) return { body: src, meta: null, raw: null }
  return { body: after, meta, raw: yamlText }
}

/**
 * 极简 YAML 子集解析（仅我们写出的字段）。
 * 不引入 js-yaml；失败返回 null。
 */
function parseSimpleFrontmatter(yamlText: string): ParsedFrontmatterMeta | null {
  const meta: ParsedFrontmatterMeta = {}
  const lines = yamlText.split('\n')
  let i = 0
  let sawAny = false
  /** 出现过「不像 YAML」的非空行（散文）：整段视为正文，不做 frontmatter 剥离 */
  let sawProse = false

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

    if (/^tags\s*:\s*\[/.test(trimmed)) {
      // 内联流式：tags: [a, b, "c d"] —— Obsidian Properties 面板与手写都常见
      // 与块列表分支一致：只解引号，归一化交给调用方（ingest / docImport 自行 normalizeTagList）
      const inner = trimmed.replace(/^tags\s*:\s*\[/, '').replace(/\]\s*$/, '')
      meta.tags = inner
        .split(',')
        .map((s) => unquoteYaml(s.trim()))
        .filter(Boolean)
      sawAny = true
      i++
      continue
    }

    if (/^tags\s*:\s*(?!\[)(.+)$/.test(trimmed)) {
      // 单标量：tags: dev —— Obsidian 也接受单值
      const m = trimmed.match(/^tags\s*:\s*(?!\[)(.+)$/)!
      meta.tags = [unquoteYaml(m[1]!.trim())].filter(Boolean)
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

    const aiExclude = trimmed.match(/^notefast_ai_exclude\s*:\s*(.*)$/)
    if (aiExclude) {
      const v = unquoteYaml(aiExclude[1]!.trim()).toLowerCase()
      if (v === 'true' || v === 'false') meta.notefast_ai_exclude = v === 'true'
      sawAny = true
      i++
      continue
    }

    const status = trimmed.match(/^notefast_status\s*:\s*(.*)$/)
    if (status) {
      const v = unquoteYaml(status[1]!.trim()).toLowerCase()
      if (v === 'inbox' || v === 'note') meta.notefast_status = v
      sawAny = true
      i++
      continue
    }

    // 未知键：像 YAML（`key:` / `key: value`，或缩进续行）就照常跳过并计入 sawAny ——
    // 否则「只有用户自定义字段」的 frontmatter 会被判为无 frontmatter，
    // 整段 YAML 被当成正文入库（vault 写回再把它写回正文，越写越脏）。
    // 不像 YAML 的行记为散文：只要出现一行散文，整段就按正文处理，
    // 避免把以 `---` 分隔线开头的普通 Markdown 误判成 frontmatter。
    if (/^[A-Za-z_][\w.-]*\s*:(\s|$)/.test(trimmed) || /^\s+\S/.test(line)) sawAny = true
    else sawProse = true
    i++
  }

  return sawAny && !sawProse ? meta : null
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

// ───────────────────── vault 写回：frontmatter 行级透传（RFC 0003 阶段 B） ─────────────────────

/** 写回时可管理的 NoteFast 元数据键；不在 patch 里的键绝不触碰 */
export interface FrontmatterPatch {
  tags?: string[] | null
  notefast_ai_exclude?: boolean | null
  notefast_status?: 'inbox' | 'note' | null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 找某个顶层 YAML 键的「记录」区间 [start, end)。
 * 记录 = 键行 + 其下连续的缩进行（块列表 `- x` / 多行标量）。
 * 找不到返回 null。
 */
function findTopLevelEntry(lines: string[], key: string): { start: number; end: number } | null {
  const keyRe = new RegExp(`^${escapeRegExp(key)}:`)
  for (let i = 0; i < lines.length; i++) {
    if (keyRe.test(lines[i]!)) {
      let end = i + 1
      while (end < lines.length && (lines[end]!.startsWith(' ') || lines[end]!.startsWith('\t'))) end++
      return { start: i, end }
    }
  }
  return null
}

/**
 * 替换 / 删除 / 插入一个顶层 YAML 键。replacement 为 null 或空数组 = 删除该键；
 * 键不存在且 replacement 非空 = 在末尾插入。其余行零改动。
 */
function patchTopLevelKey(lines: string[], key: string, replacement: string[] | null): string[] {
  const entry = findTopLevelEntry(lines, key)
  if (!entry) {
    if (!replacement || replacement.length === 0) return lines
    const insertAt = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    return [...lines.slice(0, insertAt), ...replacement, ...lines.slice(insertAt)]
  }
  if (!replacement || replacement.length === 0) {
    return [...lines.slice(0, entry.start), ...lines.slice(entry.end)]
  }
  return [...lines.slice(0, entry.start), ...replacement, ...lines.slice(entry.end)]
}

function tagsBlock(tags: string[]): string[] {
  return ['tags:', ...tags.map((t) => `  - ${yamlScalar(t)}`)]
}

/**
 * 对 frontmatter 原文（不含首尾 `---`）做行级 patch：只增删改 patch 里出现的键，
 * 其余行原样保留；输出不含首尾换行（顶部/末尾空白被折叠）。
 * raw 为 null（无 frontmatter）时按 patch 从零生成；patch 全空且无键则返回 ''。
 */
export function patchFrontmatter(raw: string | null, patch: FrontmatterPatch): string {
  const hasTags = patch.tags !== undefined
  const hasAi = patch.notefast_ai_exclude !== undefined
  const hasStatus = patch.notefast_status !== undefined
  const any = hasTags || hasAi || hasStatus

  if (raw == null || raw === '') {
    if (!any) return ''
    const fresh: string[] = []
    if (hasTags && (patch.tags?.length ?? 0) > 0) fresh.push(...tagsBlock(normalizeTagList(patch.tags!)))
    if (hasAi && patch.notefast_ai_exclude === true) fresh.push('notefast_ai_exclude: true')
    if (hasStatus && patch.notefast_status === 'inbox') fresh.push('notefast_status: inbox')
    return fresh.join('\n')
  }

  // 顶部与尾部空白折叠，行级处理，其余内容零改动
  let out = raw.replace(/^\n+/, '').replace(/\n+$/, '').split('\n')
  if (hasTags) {
    out = patchTopLevelKey(out, 'tags', patch.tags && patch.tags.length > 0 ? tagsBlock(normalizeTagList(patch.tags)) : null)
  }
  if (hasAi) {
    out = patchTopLevelKey(out, 'notefast_ai_exclude', patch.notefast_ai_exclude === true ? ['notefast_ai_exclude: true'] : null)
  }
  if (hasStatus) {
    out = patchTopLevelKey(
      out,
      'notefast_status',
      patch.notefast_status === 'inbox' ? ['notefast_status: inbox'] : null,
    )
  }

  const nonEmpty = out.filter((l) => l.trim() !== '')
  if (nonEmpty.length === 0) return ''
  return out.join('\n')
}
