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
 * 从 doc.properties 读 tags（容错：properties 可能是字符串 / 对象 / null）
 */
export function readTagsFromProperties(properties: unknown): Tag[] {
  if (!properties) return []
  let obj: Record<string, unknown>
  if (typeof properties === 'string') {
    try {
      obj = JSON.parse(properties) as Record<string, unknown>
    } catch {
      return []
    }
  } else if (typeof properties === 'object') {
    obj = properties as Record<string, unknown>
  } else {
    return []
  }
  const raw = obj.tags
  if (!Array.isArray(raw)) return []
  return normalizeTagList(raw.filter((x): x is string => typeof x === 'string'))
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
    return readTagsFromProperties(docRow.properties)
  }

  setDocTags(docRow: BlockRow, tags: Tag[]): BlockRow {
    const normalized = normalizeTagList(tags)
    let props: Record<string, unknown> = {}
    if (docRow.properties) {
      if (typeof docRow.properties === 'string') {
        try {
          props = JSON.parse(docRow.properties) as Record<string, unknown>
        } catch {
          props = {}
        }
      } else if (typeof docRow.properties === 'object') {
        props = { ...(docRow.properties as Record<string, unknown>) }
      }
    }
    if (normalized.length === 0) {
      delete props.tags
    } else {
      props.tags = normalized
    }
    return { ...docRow, properties: JSON.stringify(props) }
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