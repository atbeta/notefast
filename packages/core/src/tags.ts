/**
 * 标签抽象
 *
 * 设计原则：**不绑死实现**。当前默认实现 `PropertiesTagProvider` 从
 * `doc.properties.tags: string[]` 读，但未来可换任意实现：
 *   - 解析 markdown frontmatter（`tags: [a, b]`）
 *   - 扫描正文 `#tag`
 *   - AI 提议后人工确认（类似 AutoLink Inbox）
 *   - 文件夹映射（用某个外部标签系统）
 *
 * 替换实现 = 改一行注入。不动调用方代码。
 */

import type { BlockRow } from './types'

/** 单个 tag 字符串。normalize 后小写、去前后空格、限长 64。 */
export type Tag = string

/**
 * 一个 tag 的统计信息（用于侧边栏 / filter UI）
 */
export interface TagInfo {
  tag: Tag
  count: number
}

/**
 * TagProvider 抽象
 *
 * 任何具体实现都要给一个 `name`（用于日志 / 调试）并实现：
 *   - listTags(notebookId)     → 所有用过的 tag + count
 *   - getDocTags(docRow)       → 单文档的 tag 列表
 *   - setDocTags(docRow, tags) → 持久化新 tag 列表，返回更新后的 BlockRow
 *
 * 注意：`docRow` 是数据库行格式（含 properties 字符串），实现内部负责
 * JSON.parse / JSON.stringify。调用方只接触纯 tag 数组。
 */
export interface TagProvider {
  readonly name: string
  listTags(notebookId: string): TagInfo[]
  getDocTags(docRow: BlockRow): Tag[]
  setDocTags(docRow: BlockRow, tags: Tag[]): BlockRow
}

// ───────────────────── 工具函数 ─────────────────────

/**
 * 归一化一个 tag：小写、去前后空格、合并中间空格、限长 64。
 * - 空字符串 / 仅空白 → null（无效）
 * - 包含特殊字符 → 原样保留（hash / path 等合法字符）
 */
export function normalizeTag(input: string): Tag | null {
  const trimmed = input.trim().toLowerCase().replace(/\s+/g, '-')
  if (!trimmed) return null
  if (trimmed.length > 64) return null
  return trimmed
}

/**
 * 归一化 + 去重 + 排序 tag 列表（用于持久化）
 */
export function normalizeTagList(tags: readonly string[]): Tag[] {
  const seen = new Set<Tag>()
  for (const t of tags) {
    const n = normalizeTag(t)
    if (n) seen.add(n)
  }
  return Array.from(seen).sort()
}

/**
 * 解析 properties 为对象（容错：字符串 / 对象 / null）
 */
export function parsePropertiesObject(properties: unknown): Record<string, unknown> {
  if (!properties) return {}
  if (typeof properties === 'string') {
    try {
      const obj = JSON.parse(properties) as unknown
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return obj as Record<string, unknown>
      }
      return {}
    } catch {
      return {}
    }
  }
  if (typeof properties === 'object' && !Array.isArray(properties)) {
    return { ...(properties as Record<string, unknown>) }
  }
  return {}
}

/**
 * 从 doc.properties 读 tags（容错：properties 可能是字符串 / 对象 / null）
 * @deprecated 使用 readTags(row) 从显式列读取
 */
export function readTagsFromProperties(properties: unknown): Tag[] {
  const obj = parsePropertiesObject(properties)
  const raw = obj.tags
  if (!Array.isArray(raw)) return []
  return normalizeTagList(raw.filter((x): x is string => typeof x === 'string'))
}

/** 从 BlockRow 显式 tags 列读取标签 */
export function readTags(row: BlockRow): Tag[] {
  try {
    const parsed = JSON.parse(row.tags ?? '[]')
    if (!Array.isArray(parsed)) return []
    return normalizeTagList(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    return []
  }
}

/** 将标签数组序列化为 JSON 字符串（用于写入 tags 列） */
export function writeTags(tags: Tag[]): string {
  return JSON.stringify(normalizeTagList(tags))
}

/**
 * 从 doc.properties 读 ai_exclude（仅 true 时为排除）
 * @deprecated 使用 readAiExclude(row) 从显式列读取
 */
export function readAiExcludeFromProperties(properties: unknown): boolean {
  const obj = parsePropertiesObject(properties)
  return obj.ai_exclude === true
}

/** 从 BlockRow 显式 ai_exclude 列读取 */
export function readAiExclude(row: BlockRow): boolean {
  return row.ai_exclude === 1
}

/**
 * 写入 / 清除 properties.ai_exclude，返回新的 properties JSON 字符串
 * @deprecated 直接写 blocks.ai_exclude 列
 */
export function setAiExcludeInProperties(properties: unknown, aiExclude: boolean): string {
  const props = parsePropertiesObject(properties)
  if (aiExclude) {
    props.ai_exclude = true
  } else {
    delete props.ai_exclude
  }
  return JSON.stringify(props)
}

export type TagMatchMode = 'any' | 'all'

/**
 * 解析 tag_match 查询参数。默认 `all`（同时包含 / AND）。
 * 接受 `any` / `or` 表示包含任一。
 */
export function parseTagMatchMode(raw: string | null | undefined): TagMatchMode {
  const v = (raw || '').trim().toLowerCase()
  if (v === 'any' || v === 'or') return 'any'
  return 'all'
}

/**
 * 文档 tags 是否匹配筛选条件。
 * - mode `all`（默认）：必须包含全部 selected（AND）
 * - mode `any`：命中 selected 中任一 tag（OR）
 * selected 为空时视为不筛选（返回 true）
 */
export function docMatchesTags(
  docTags: readonly string[],
  selected: readonly string[],
  mode: TagMatchMode = 'all',
): boolean {
  const want = normalizeTagList([...selected])
  if (want.length === 0) return true
  const have = new Set(normalizeTagList([...docTags]))
  if (mode === 'all') return want.every((t) => have.has(t))
  return want.some((t) => have.has(t))
}

/** 解析 `tags=a,b` 或单个 `tag` 查询串为 normalize 后的列表 */
export function parseTagsQueryParam(tagsParam: string | null | undefined, tagParam?: string | null): Tag[] {
  const parts: string[] = []
  if (tagsParam) {
    for (const p of tagsParam.split(',')) parts.push(p)
  }
  if (tagParam) parts.push(tagParam)
  return normalizeTagList(parts)
}

/** 解析 updated_within：仅支持 24h / 7d，其它返回 null */
export function parseUpdatedWithin(raw: string | null | undefined): number | null {
  const v = (raw || '').trim().toLowerCase()
  if (v === '24h') return 24 * 60 * 60 * 1000
  if (v === '7d') return 7 * 24 * 60 * 60 * 1000
  return null
}

// ───────────────────── 默认实现 ─────────────────────

/**
 * 默认实现：从 `block.properties.tags: string[]` 读写
 *
 * 为什么是默认：所有 doc 已经有 `properties` JSON 字段，不需要改 schema，
 * 也不需要迁移老数据（properties 可能为空 JSON `{}`，此时无 tag）。
 *
 * 切换路径：未来要做 frontmatter 解析 / #tag 提取时，新建一个
 * `FrontmatterTagProvider` 实现 TagProvider 接口，在 server 启动时
 * 替换 `setTagProvider(...)` 调用即可。
 */
export class PropertiesTagProvider implements TagProvider {
  readonly name = 'properties'

  /**
   * 列出 notebook 下所有 tag + count。O(n) 扫所有 doc root blocks。
   * 注：当前实现不维护 tag 索引，笔记量大时 (>1000) 可考虑建
   * `doc_tags(doc_id, tag)` 反向表 + 缓存层。
   */
  listTags(notebookId: string): TagInfo[] {
    // 这里我们不接 db，只声明接口。Server 端会注入一个实现，
    // 这个方法在 server 实现里会被重写（拿 db 来扫）。
    // 默认实现仅返回空，让上层走 SQL 自己算。
    void notebookId
    throw new Error('PropertiesTagProvider.listTags requires db access; use server-side implementation')
  }

  getDocTags(docRow: BlockRow): Tag[] {
    return readTags(docRow)
  }

  setDocTags(docRow: BlockRow, tags: Tag[]): BlockRow {
    const normalized = normalizeTagList(tags)
    return { ...docRow, tags: writeTags(normalized) }
  }
}

// ───────────────────── Provider 注册 ─────────────────────

let _provider: TagProvider = new PropertiesTagProvider()

/** 替换全局 TagProvider（仅 server 启动时调用一次） */
export function setTagProvider(p: TagProvider): void {
  _provider = p
}

/** 取当前生效的 Provider（默认 = PropertiesTagProvider） */
export function getTagProvider(): TagProvider {
  return _provider
}