/**
 * 实体词典（term-dict）—— 用户声明的「实体校准层」
 *
 * 定位：entities 表是 autoLink 自动抽取的结果（不可控），词典是用户显式声明的
 * 校准规则——抽取 / 检索 / 归并全部向词典标准名收敛。行业（半导体、软件…）只是
 * 词典内容，软件本身不绑定任何行业：data/term-dict.json 不存在 = 空词典 = 现状零变化。
 *
 * 条目语义：
 *   { "name": "晶圆", "aliases": ["wafer", "晶圆片"], "kind": "concept" }
 *   name  = 标准名（别名归并的目标，抽取/查询都向其收敛）
 *   aliases = 别名（抽取端命中即路由到标准名实体；查询端命中即展开为 OR 组）
 *   kind  = 可选 kind 覆盖（仅建实体时生效；存量覆盖走 rebuild）
 *
 * 消费方：
 * - ai/entities.registerMentions：别名 → 标准名实体（源头防分裂）
 * - lexicalSearch：term 命中别名/标准名 → 展开 OR 组（查 wafer 命中「晶圆」文档）
 * - ai/entitySearch：别名反向 resolve 到标准名（实体路精确匹配）
 * - termDict.rebuildDictEntities：存量归并（PUT 后自动 + POST 手动）
 *
 * 匹配键统一 dictKey = fullToHalfWidth(normalizeEntityName(x))：
 * trim/lowercase/去首尾标点/压缩空白 + 全角→半角（「（晶圆）」与「(晶圆)」同键）。
 * 精确匹配不子串——词典是显式声明，子串匹配会误伤（「晶圆」是「晶圆厂」子串）。
 * 注意：fullToHalfWidth 只作用于匹配键，display/标准名原始写法原样保留；
 * 实体归并键 normalizeEntityName 不含全半角转换（实体表存量保持稳定）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fullToHalfWidth } from '@notefast/core'
import { getDb } from './db'
import { normalizeEntityName, upsertEntity, findEntityByName, mergeEntities } from './store/entities'

const CONFIG_FILE = 'term-dict.json'

/** 词典匹配键：全角→半角 + 规范实体名（词典内部使用，不影响实体表归并键） */
function dictKey(s: string): string {
  return fullToHalfWidth(normalizeEntityName(s))
}

export interface TermDictEntry {
  /** 标准名（原始写法，用于 display） */
  name: string
  /** 别名（原始写法） */
  aliases: string[]
  /** 可选 kind 覆盖（concept/person/tool/doc） */
  kind?: string
  /** 可选描述：实体释义（用户声明层，优先级高于 AI 生成；人读 + AI 读） */
  description?: string
}

export interface TermDict {
  entries: TermDictEntry[]
  /** normalized 名称（标准名 + 别名）→ 条目；查询/抽取 O(1) 命中 */
  byNormalized: Map<string, TermDictEntry>
}

let dataDir = ''
let cache: TermDict | null = null

export function initTermDict(dir: string): void {
  dataDir = dir
  cache = null
}

/** 测试用：清空目录与缓存（bun 跨文件共享模块状态） */
export function resetTermDictForTests(): void {
  dataDir = ''
  cache = null
}

export function dictFilePath(): string | null {
  return dataDir ? join(dataDir, CONFIG_FILE) : null
}

/** 从磁盘加载并规范化（容错：文件缺失/解析失败 → 空词典 + 告警，不拖垮主流程） */
export function loadTermDictFromDisk(): TermDict {
  const path = dictFilePath()
  const empty: TermDict = { entries: [], byNormalized: new Map() }
  if (!path || !existsSync(path)) return empty

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    console.warn(`📖 实体词典: ${path} 解析失败，按空词典加载:`, e)
    return empty
  }
  const list = Array.isArray(raw) ? raw : (raw as { terms?: unknown })?.terms
  if (!Array.isArray(list)) {
    console.warn(`📖 实体词典: ${path} 缺少 terms 数组，按空词典加载`)
    return empty
  }

  const entries: TermDictEntry[] = []
  const byNormalized = new Map<string, TermDictEntry>()
  let skipped = 0
  for (const item of list) {
    const e = item as Partial<TermDictEntry>
    if (typeof e.name !== 'string' || e.name.trim().length === 0) {
      skipped++
      continue
    }
    const nameNorm = dictKey(e.name)
    if (nameNorm.length < 2) {
      skipped++
      continue
    }
    const rawAliases = Array.isArray(e.aliases)
      ? e.aliases
          .map((a) => (typeof a === 'string' ? a.trim() : ''))
          .filter((a) => a.length >= 2 && dictKey(a) !== nameNorm && dictKey(a).length >= 2)
      : []
    // 别名按 normalized 去重（'Wafer' 与 'wafer' 归一后同键，保留首个写法）
    const seenAliases = new Set<string>()
    const aliases: string[] = []
    for (const a of rawAliases) {
      const an = dictKey(a)
      if (seenAliases.has(an)) continue
      seenAliases.add(an)
      aliases.push(a)
    }
    const kind = typeof e.kind === 'string' && ['concept', 'person', 'tool', 'doc'].includes(e.kind)
      ? e.kind
      : undefined
    const description = typeof e.description === 'string' && e.description.trim().length > 0
      ? e.description.trim()
      : undefined
    const entry: TermDictEntry = {
      name: e.name.trim(),
      aliases: [...new Set(aliases)],
      ...(kind ? { kind } : {}),
      ...(description ? { description } : {}),
    }
    if (byNormalized.has(nameNorm)) {
      skipped++
      continue
    }
    entries.push(entry)
    byNormalized.set(nameNorm, entry)
    for (const a of entry.aliases) byNormalized.set(dictKey(a), entry)
  }
  if (skipped > 0) {
    console.warn(`📖 实体词典: 跳过 ${skipped} 条无效条目（标准名 <2 字 / 别名与标准名相同 / 重复）`)
  }
  return { entries, byNormalized }
}

/** 当前生效词典（惰性加载 + 内存缓存；PUT 后须 invalidateTermDict） */
export function getTermDict(): TermDict {
  if (!cache) cache = loadTermDictFromDisk()
  return cache
}

export function invalidateTermDict(): void {
  cache = null
}

/** 词典规模摘要（API/UI 展示用） */
export function dictStats(): { entries: number; aliases: number } {
  const d = getTermDict()
  return { entries: d.entries.length, aliases: d.entries.reduce((n, e) => n + e.aliases.length, 0) }
}

/**
 * 词典路由：normalized 名称命中（标准名或别名）→ 返回标准名信息。
 * 供抽取端（registerMentions）把别名锚点收敛到标准名实体。
 */
export function resolveDictTerm(name: string): { name: string; display: string; kind?: string; description?: string } | null {
  const entry = getTermDict().byNormalized.get(dictKey(name))
  return entry
    ? { name: normalizeEntityName(entry.name), display: entry.name, kind: entry.kind, description: entry.description }
    : null
}

/**
 * 实体描述（词典层）：标准名/别名命中即返回词典描述；未命中 undefined。
 * 有效描述 = dictDescriptionFor(name) ?? entities.description（词典 > AI 生成）。
 */
export function dictDescriptionFor(name: string): string | undefined {
  return resolveDictTerm(name)?.description
}

/**
 * 查询端展开：term 命中词典 → [原 term, 标准名, ...别名]（去重）。
 * 未命中返回 null（调用方保持单 term）。匹配键 = normalizeEntityName(term)。
 */
export function expandDictTerm(term: string): string[] | null {
  const entry = getTermDict().byNormalized.get(dictKey(term))
  if (!entry) return null
  return [...new Set([term, entry.name, ...entry.aliases])]
}

// ───────────────────── 保存与存量归并 ─────────────────────

/** 校验并落盘（调用方已做 zod 结构校验）；返回规范化后的词典。失败抛 Error（中文消息）。 */
export function saveTermDictToDisk(terms: TermDictEntry[]): TermDict {
  const path = dictFilePath()
  if (!path) throw new Error('数据目录未初始化')
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })

  // 语义校验（结构校验在 API zod 层）：标准名 ≥2 字、别名 ≥2 字且不与标准名相同、无重复标准名
  const seen = new Set<string>()
  for (const t of terms) {
    const n = dictKey(t.name)
    if (n.length < 2) throw new Error(`标准名过短：「${t.name}」`)
    if (seen.has(n)) throw new Error(`标准名重复：「${t.name}」`)
    seen.add(n)
    for (const a of t.aliases) {
      const an = dictKey(a)
      if (an.length < 2) throw new Error(`别名过短：「${a}」`)
      if (an === n) throw new Error(`别名与标准名相同：「${a}」`)
    }
  }

  writeFileSync(path, JSON.stringify({ version: 1, terms }, null, 2) + '\n')
  invalidateTermDict()
  cache = loadTermDictFromDisk()
  return cache
}

export interface DictRebuildResult {
  /** 归并掉的旧实体数（别名实体 → 标准实体） */
  merged: number
  /** 新建的标准实体数 */
  created: number
  /** kind 被词典覆盖更新的实体数 */
  kindUpdated: number
}

/**
 * 存量归并：把现有实体按词典规则收敛到标准名实体。
 * 1) 确保每个标准名实体存在（kind 覆盖：已有实体 kind 被词典指定值更新）
 * 2) 别名/标准名命中的既有实体 → mergeEntities 合并进标准实体
 *    （mergeEntities 会迁移提及、重算 count、把旧名登记为别名——与手工合并同一路径）
 * 幂等：重复跑只收敛一次，无副作用。
 */
export function rebuildDictEntities(): DictRebuildResult {
  const db = getDb()
  const dict = getTermDict()
  const result: DictRebuildResult = { merged: 0, created: 0, kindUpdated: 0 }

  // 第一遍：确保标准实体存在 + kind 覆盖
  for (const entry of dict.entries) {
    const name = normalizeEntityName(entry.name)
    const existing = findEntityByName(db, name)
    if (!existing) {
      upsertEntity(db, { name, display: entry.name, kind: entry.kind ?? 'concept' })
      result.created++
    } else if (entry.kind && existing.kind !== entry.kind) {
      db.query(`UPDATE entities SET kind = ?, updated_at = datetime('now') WHERE id = ?`).run(
        entry.kind,
        existing.id,
      )
      result.kindUpdated++
    }
  }

  // 第二遍：别名/标准名命中的既有实体 → 归并到标准实体
  for (const entry of dict.entries) {
    const standard = findEntityByName(db, normalizeEntityName(entry.name))
    if (!standard) continue
    const aliases = [entry.name, ...entry.aliases]
    for (const alias of aliases) {
      const from = findEntityByName(db, normalizeEntityName(alias))
      if (!from || from.id === standard.id) continue
      mergeEntities(db, from.id, standard.id)
      result.merged++
    }
  }
  return result
}
